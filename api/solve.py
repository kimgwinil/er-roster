"""번표 자동 생성 API (Vercel Python 함수).

POST /api/solve  body: {"scenario": <시나리오 JSON>, "timeLimit": 초}
응답: {"roster": {직원id: [코드...]}, "relaxed": [...], "status": ..., "seconds": ...}

시나리오에는 이름이 없어도 된다(앱은 이름을 빼고 id 만 보낸다). 서버는 아무것도 저장하지 않는다.
"""

import datetime as dt
import json
import os
import time
from http.server import BaseHTTPRequestHandler

from ortools.sat.python import cp_model

WORK = ["D", "E", "N", "소아", "미드"]
REST = ["주휴", "OF", "휴가", "공가", "교육", "병가", "경조", "생휴", "수휴"]  # 공가·교육·병가·경조·생휴·수휴는 지정한 날에만
DESIGNATED = ("공가", "교육", "병가", "경조", "생휴", "수휴")
NONE = "-"  # 재직 기간 아님 (입사 전 / 퇴사 후)
CODES = WORK + REST + [NONE]
SHIFTS = ["D", "E", "N", "소아"]
DEFAULT_FORBIDDEN = [["E", "D"], ["N", "D"], ["N", "E"], ["소아", "D"],
                     ["N", "소아"], ["N", "미드"], ["미드", "D"], ["E", "미드"]]


def _date(s):
    return dt.date.fromisoformat(s)


class Problem:
    def __init__(self, sc):
        self.sc = sc
        self.start = _date(sc["startDate"])
        self.n_days = int(sc["days"])
        self.dates = [self.start + dt.timedelta(d) for d in range(self.n_days)]
        # 0=일요일
        self.wd = [(d.weekday() + 1) % 7 for d in self.dates]
        self.cap_until = _date(sc["leaveCapUntil"]) if sc.get("leaveCapUntil") else self.dates[-1]
        self.staff = sc["staff"]
        self.sid = [s["id"] for s in self.staff]
        self.idx = {s["id"]: i for i, s in enumerate(self.staff)}
        r = sc.get("rules", {})
        self.demand = {k: int(sc.get("demand", {}).get(k, 0)) for k in SHIFTS}
        self.charge_min = int(r.get("chargeMin", 0))
        self.charge_max = int(r.get("chargeMax", 99))
        # 차지 인원 우선: 신청오프(60000)보다 먼저 지킴 → 차지가 범위를 벗어나느니 신청오프를 근무로 바꿈
        self.charge_first = bool(r.get("chargeFirst"))
        # 신청 번호(달력의 OFF 옆 괄호 숫자)가 이 값 이상이면 1순위 반려
        self.reject_from = r.get("rejectRankFrom")
        # 반려 한도: 하루 n명까지, 같은 사람은 기간 중 1번까지
        self.reject_per_day = r.get("maxRejectPerDay")
        self.reject_once = bool(r.get("rejectOncePerPerson"))
        self.new_max = int(r.get("newMax", 99))
        self.max_work = int(r.get("maxWork", 5))
        self.max_night = int(r.get("maxNight", 3))
        self.forbidden = [tuple(p) for p in r.get("forbidden", DEFAULT_FORBIDDEN)]
        self.night_rest = int(r.get("nightBlockRest", 2))  # 연속 N(2개 이상) 뒤 필요한 휴무 수

        self.allowed = {}  # (i, d) -> set(codes)  지정·잠금
        self.extra_off = set()  # (i, d): 주 OF 개수와 별도로 인정하는 추가 OF 지정
        for f in sc.get("fixed", []):
            i = self.idx.get(f["staff"])
            d = self.day(f["date"])
            if i is None or d is None:
                continue
            if f.get("extraOff"):
                self.extra_off.add((i, d))
            cur = self.allowed.get((i, d), set(CODES))
            self.allowed[(i, d)] = cur & set(f["allowed"])
        self.requests = {}
        for q in sc.get("requests", []):
            i = self.idx.get(q["staff"])
            d = self.day(q["date"])
            if i is not None and d is not None:
                self.requests[(i, d)] = q
        self.employed = []
        for s in self.staff:
            a = _date(s["startDate"]) if s.get("startDate") else None
            b = _date(s["endDate"]) if s.get("endDate") else None
            self.employed.append([(a is None or day >= a) and (b is None or day <= b) for day in self.dates])

    def day(self, s):
        k = (_date(s) - self.start).days
        return k if 0 <= k < self.n_days else None

    def in_ranges(self, ranges, d):
        day = self.dates[d]
        return any(_date(r["from"]) <= day <= _date(r["to"]) for r in ranges or [])


GROUPS = {"근무": WORK, "휴무": REST, "*": CODES}
HARD_W = 30000  # 금지 조건을 불가피하게 어길 때의 벌점 (하루 인원·소아 구성보다는 낮게)
SOFT_W = {1: 20, 2: 60, 3: 200}  # 지향 조건 중요도별 벌점


def token_codes(tok):
    """'N', 'E|소아', '근무', '휴무', '*', '!N' → 해당 코드 집합"""
    neg = tok.startswith("!")
    t = tok[1:] if neg else tok
    codes = set()
    for part in t.split("|"):
        part = part.strip()
        codes |= set(GROUPS.get(part, [part]))
    return set(CODES) - codes if neg else codes


def request_weight(q, reject_from=None):
    """신청오프를 못 지킬 때의 벌점. 작을수록 먼저 반려."""
    rank, pri = q.get("rank"), q.get("priority")
    if pri == "first" or (rank is not None and reject_from and rank >= reject_from):
        return 6000
    if pri == "low":
        return 8000
    if rank is not None:
        return 20000 + 1500 * max(0, 25 - int(rank))
    return 60000


def _build(sc, strict):
    P = Problem(sc)
    v2 = int(sc.get("version", 1)) >= 2  # 2 이상: 근무 순서 규칙을 conditions 로 받음
    m = cp_model.CpModel()
    S, ND = len(P.staff), P.n_days
    x = {(i, d, c): m.new_bool_var("") for i in range(S) for d in range(ND) for c in CODES}
    penalties = []
    relax = []  # (weight, bool/int var, 설명 dict)

    def elastic_le(expr, rhs, weight, info, slack=50):
        v = m.new_int_var(0, slack, "")
        m.add(expr <= rhs + v)
        relax.append((weight, v, info))

    def elastic_ge(expr, rhs, weight, info, slack=50):
        v = m.new_int_var(0, slack, "")
        m.add(expr + v >= rhs)
        relax.append((weight, v, info))

    # ------------------------------------------------ 셀 기본 제약
    const = {}  # (i, d) -> 확정 코드 (잠금·단일 허용)
    soft_req = []  # (i, d, 허용 코드, 벌점) — 신청오프
    for i, s in enumerate(P.staff):
        allowed_work = set(s.get("allowed") or WORK) | {"미드"}
        roles = s.get("roles", {})
        for d in range(ND):
            m.add_exactly_one(x[i, d, c] for c in CODES)
            ok = set(CODES)
            if not P.employed[i][d]:
                ok = {NONE}
            else:
                ok.discard(NONE)
                ok &= allowed_work | set(REST)
                if not (roles.get("pedsCharge") or roles.get("pedsActing") or roles.get("pedsBackup")) or roles.get("newbie"):
                    ok.discard("소아")
                fixed = P.allowed.get((i, d))
                if fixed is None or "미드" not in fixed:
                    ok.discard("미드")
                for special in DESIGNATED:  # 공가·교육·병가·경조는 그날을 지정한 경우에만
                    if fixed != {special}:
                        ok.discard(special)
                for fw in s.get("fixedWeekdays", []):
                    if P.wd[d] == int(fw["weekday"]):
                        ok &= {fw["code"]}
                # 주휴: 고정 요일에만, 고정 요일에는 반드시 (지정으로 다르게 정한 날 제외)
                if P.wd[d] == int(s["juhu"]):
                    if fixed is None or "주휴" in fixed:
                        ok &= {"주휴"}
                else:
                    ok.discard("주휴")
                if fixed is not None:
                    ok &= fixed
                q = P.requests.get((i, d))
                if q:
                    alt = q.get("alt")
                    want = {"휴가"} if q.get("onlyLeave") else {"주휴", "OF", "휴가"}
                    if alt:
                        want |= {alt}
                    if ok & want:
                        # 항상 벌점으로: 인원 부족(100000) > 신청오프(번호 없음 60000, 번호 n은 20000~56000 — 클수록 먼저 반려)
                        #   > 후순위(8000) > 1순위 반려(6000) > 차지 5명(4000)
                        # → 인원을 못 채울 때만 신청오프가 빠지고, 빠진 신청은 '신청오프 미반영'으로 표시
                        soft_req.append((i, d, ok & want, request_weight(q, P.reject_from)))
            if not ok:  # 서로 모순되는 지정 → 지정 우선
                ok = P.allowed.get((i, d)) or {NONE}
            for c in CODES:
                if c not in ok:
                    m.add(x[i, d, c] == 0)
            if len(ok) == 1:
                const[(i, d)] = next(iter(ok))

    # 신청오프를 지키지 못하면 벌점 (우선순위 낮은 신청 8000 — 차지 5명 허용(4000)보다 나중에 바뀜)
    misses = []
    for i, d, want, w in soft_req:
        miss = m.new_bool_var("")
        m.add(sum(x[i, d, c] for c in want) + miss >= 1)
        relax.append((w, miss, {"type": "신청오프 미반영", "staff": P.sid[i], "date": str(P.dates[d])}))
        misses.append((i, d, miss))
    # 반려 한도는 하루 인원(100000)보다 우선 — 한도를 넘느니 그날 인원이 모자라게 둠
    if P.reject_per_day is not None:
        for d in range(ND):
            day = [mv for _, dd, mv in misses if dd == d]
            if len(day) > int(P.reject_per_day):
                elastic_le(sum(day), int(P.reject_per_day), 150000, {"type": "반려 한도 초과", "date": str(P.dates[d])})
    if P.reject_once:
        for i in range(S):
            mine = [mv for ii, _, mv in misses if ii == i]
            if len(mine) > 1:
                elastic_le(sum(mine), 1, 150000, {"type": "같은 사람 반려 2회", "staff": P.sid[i]})

    def v(i, d, c):
        """d<0: 직전 근무(상수). 확정 셀은 상수."""
        if d < 0:
            prev = P.staff[i].get("prev", [])
            k = len(prev) + d
            return int(k >= 0 and prev[k] == c)
        if d >= ND:
            return 0
        if (i, d) in const:
            return int(const[(i, d)] == c)
        return x[i, d, c]

    def work(i, d):
        return sum(v(i, d, c) for c in WORK)

    def rest(i, d):
        return sum(v(i, d, c) for c in REST)

    def add_le(expr, rhs):
        """모든 항이 상수면(이미 정해진 셀) 생략 — 위반 여부는 앱 검증에서 표시."""
        if isinstance(expr, int):
            return
        m.add(expr <= rhs)

    # ------------------------------------------------ 하루 인원·구성
    roles = [s.get("roles", {}) for s in P.staff]
    for d in range(ND):
        for sh in SHIFTS:
            need = P.demand[sh]
            tot = sum(x[i, d, sh] for i in range(S))
            m.add(tot <= need)
            elastic_ge(tot, need, 100000, {"type": "인원 부족", "date": str(P.dates[d]), "shift": sh})
        if P.demand["소아"] >= 2:  # 소아 구성은 신청오프(60000)보다 우선
            elastic_ge(sum(x[i, d, "소아"] for i in range(S) if roles[i].get("pedsCharge") or roles[i].get("pedsBackup")), 1, 80000,
                       {"type": "소아차지 없음", "date": str(P.dates[d])}, slack=1)
            # 소아차지 대체(예: 차지 1~4번): 그날 신청오프를 반려해야 할 때만 쓰도록 반려(6000~)보다 조금 낮은 벌점
            for i in range(S):
                if roles[i].get("pedsBackup") and not roles[i].get("pedsCharge"):
                    relax.append((5000, x[i, d, "소아"], {"type": "소아차지 대체", "staff": P.sid[i], "date": str(P.dates[d])}))
            elastic_ge(sum(x[i, d, "소아"] for i in range(S) if roles[i].get("pedsActing")), 1, 80000,
                       {"type": "소아액팅 없음", "date": str(P.dates[d])}, slack=1)
        for sh in ("D", "E", "N"):
            ch = sum(x[i, d, sh] for i in range(S) if roles[i].get("charge"))
            cw = 70000 if P.charge_first else 0
            elastic_ge(ch, P.charge_min, cw or 5000, {"type": "차지 부족", "date": str(P.dates[d]), "shift": sh})
            elastic_le(ch, P.charge_max, cw or 4000, {"type": "차지 초과", "date": str(P.dates[d]), "shift": sh})
            nw = sum(x[i, d, sh] for i in range(S) if roles[i].get("newbie"))
            elastic_le(nw, P.new_max, 4000, {"type": "신규 초과", "date": str(P.dates[d]), "shift": sh})

    # ------------------------------------------------ 개인별
    fair = []
    for i, s in enumerate(P.staff):
        sid = s["id"]
        full = all(P.employed[i])
        # 주마다 OF 1개 (주휴는 셀 제약으로 처리)
        for w in range(0, ND, 7):
            days = list(range(w, min(w + 7, ND)))
            of = sum(x[i, d, "OF"] for d in days)
            whole = len(days) == 7 and all(P.employed[i][d] for d in days)
            exempt = any(P.in_ranges(s.get("ofExempt"), d) for d in days)
            if whole and not exempt:
                m.add(of >= 1)
                extra = sum(1 for d in days if (i, d) in P.extra_off)
                elastic_le(of, 1 + extra, 7000, {"type": "OF 2개", "staff": sid, "date": str(P.dates[w])}, slack=1)
            else:
                m.add(of <= 1)

        # 신청오프·공가 전날 N 금지, 휴무 전날 N 금지(개인 설정), 마지막 며칠 N 금지
        for d in range(ND):
            q = P.requests.get((i, d))
            if q and d >= 1:
                add_le(v(i, d - 1, "N") + rest(i, d), 1)
            if d >= 1 and P.allowed.get((i, d)) in ({"공가"}, {"교육"}):
                add_le(v(i, d - 1, "N"), 0)
            if s.get("noNightBeforeOff") and d + 1 < ND:
                add_le(v(i, d, "N") + v(i, d + 1, "주휴") + v(i, d + 1, "OF"), 1)
            if d >= ND - int(s.get("noNightLastDays", 0) or 0):
                add_le(v(i, d, "N"), 0)

        # 근무 패턴 (직전 근무 포함)
        L = len(s.get("prev", []))
        for d in range(-L, ND if not v2 else -L):
            if 0 <= d + 1 < ND:
                for a, b in P.forbidden:
                    add_le(v(i, d, a) + v(i, d + 1, b), 1)
            if 0 <= d + 2 < ND:
                add_le(v(i, d, "N") + rest(i, d + 1) + v(i, d + 2, "D") + v(i, d + 2, "미드"), 2)
                if d - 1 >= -L:
                    e = v(i, d - 1, "N") + v(i, d, "N") + rest(i, d + 1) + work(i, d + 2)
                    if not isinstance(e, int):
                        elastic_le(e, 3, 6000, {"type": "연속N 후 휴무 1일", "staff": sid,
                                                "date": str(P.dates[d + 2])}, slack=1)
                    se = v(i, d, "N") - v(i, d - 1, "N") + rest(i, d + 1) + v(i, d + 2, "E") + v(i, d + 2, "소아") - 2
                    if not isinstance(se, int):
                        b = m.new_bool_var("")
                        m.add(b >= se)
                        penalties.append((60, b))
        W, NM = P.max_work, P.max_night
        for d in range(-L, ND - W):
            if d + W >= 0:
                add_le(sum(work(i, d + k) for k in range(W + 1)), W)
        for d in range(-L, ND - NM):
            if d + NM >= 0:
                add_le(sum(v(i, d + k, "N") for k in range(NM + 1)), NM)

        # 개인별 소아 근무 상한
        if s.get("maxPeds") is not None:
            elastic_le(sum(x[i, d, "소아"] for d in range(ND)), int(s["maxPeds"]), 8000,
                       {"type": "소아 횟수 초과", "staff": sid})

        # 휴가 개수: 주별 시작 잔여(전주 대비 적용) 이내
        cap_days = [d for d in range(ND) if P.dates[d] <= P.cap_until]
        starts = s.get("weekLeave") or []
        if not s.get("leaveCapExempt"):
            # 날짜별: 그날까지 쓴 휴가 ≤ 시작 잔여 + 그 전날까지 쌓인 나이트 보상휴가
            acc = (sc.get("rules") or {}).get("nightAccrual") or {}
            per = int(acc.get("per") or 0)
            over = m.new_int_var(0, 50, "")
            relax.append((3000, over, {"type": "휴가 잔여 초과", "staff": sid, "date": str(P.dates[0])}))
            for t in cap_days:
                used_t = sum(x[i, d, "휴가"] for d in cap_days if d <= t)
                rhs = int(s.get("leave", 0))
                if per and acc.get("from"):
                    nd = [d for d in range(t) if _date(acc["from"]) <= P.dates[d] <= _date(acc.get("to") or str(P.cap_until))]
                    if len(nd) >= per:
                        a = m.new_int_var(0, len(nd) // per, "")
                        m.add(per * a <= sum(v(i, d, "N") for d in nd))
                        rhs = rhs + a
                m.add(used_t <= rhs + over)
            for wk, w in enumerate(range(0, ND, 7)):
                bal = starts[wk] if wk < len(starts) and starts[wk] is not None else None
                if bal is None:
                    continue
                used = sum(x[i, d, "휴가"] for d in cap_days if d >= w)
                elastic_le(used, int(bal), 3000, {"type": "휴가 잔여 초과", "staff": sid,
                                                  "date": str(P.dates[w])})
        else:
            penalties.append((500, sum(x[i, d, "휴가"] for d in cap_days)))
        if s.get("minLeave"):
            elastic_ge(sum(x[i, d, "휴가"] for d in cap_days), int(s["minLeave"]), 3000,
                       {"type": "추가 휴가 부족", "staff": sid})
        for lw in s.get("leaveWindows", []) or []:
            days = [d for d in range(ND) if _date(lw["from"]) <= P.dates[d] <= _date(lw["to"])]
            if days:
                elastic_ge(sum(x[i, d, "휴가"] for d in days), int(lw.get("min", 1)), 3000,
                           {"type": "기간 내 휴가 부족", "staff": sid, "date": lw["from"]})
        # 신청 없는 기간 밖(잔여 계산 이후) 휴가는 꼭 필요할 때만
        for d in range(ND):
            if P.dates[d] > P.cap_until and (i, d) not in P.requests and (i, d) not in P.allowed:
                penalties.append((30, x[i, d, "휴가"]))

        # 선호
        for w in range(0, ND, 7):
            days = [d for d in range(w, min(w + 7, ND))]
            jd = [d for d in days if P.wd[d] == int(s["juhu"])]
            if jd:
                near = [d for d in (jd[0] - 1, jd[0] + 1) if d in days]
                adj = m.new_bool_var("")
                m.add(adj <= sum(x[i, d, "OF"] for d in near))
                penalties.append((15, 1 - adj))
        for d in range(ND if not v2 else 0):
            if (i, d) in const:
                continue
            b = m.new_bool_var("")
            m.add(b >= x[i, d, "N"] - v(i, d - 1, "N") - (v(i, d + 1, "N") if d + 1 < ND else 1))
            penalties.append((25, b))
        for d in range(1, ND - 1):
            b = m.new_bool_var("")
            m.add(b >= rest(i, d - 1) + work(i, d) + rest(i, d + 1) - 2)
            penalties.append((5, b))

        fixed_days = sum(1 for d in range(ND) if (i, d) in P.allowed)
        if full and not s.get("allowed") and not s.get("noNightBeforeOff") and fixed_days <= 4:
            fair.append(i)

    # ------------------------------------------------ 금지·지향 조건 (conditions)
    def targets(c):
        ids = set(c.get("staff") or [])
        role = c.get("role")
        out = []
        for i, s in enumerate(P.staff):
            if ids and s["id"] not in ids:
                continue
            if role and not s.get("roles", {}).get(role):
                continue
            out.append(i)
        return out

    def in_scope(c, d):
        day = P.dates[d]
        if c.get("from") and day < _date(c["from"]):
            return False
        if c.get("to") and day > _date(c["to"]):
            return False
        wds = c.get("weekdays") or []
        return not wds or P.wd[d] in wds

    def is_const(i, d):
        return d < 0 or (i, d) in const

    def match(i, d, codes):
        return sum(v(i, d, c) for c in codes)

    def enforce(c, expr, rhs, cells, info, ge=False):
        """금지: 지킴(경계·고정 칸이 섞이면 큰 벌점으로 완화) / 지향: 어기면 벌점."""
        if isinstance(expr, int):
            return
        if c.get("level") == "금지":
            soft_hard = not strict or any(is_const(i, d) for i, d in cells)
            if soft_hard:
                (elastic_ge if ge else elastic_le)(expr, rhs, HARD_W, info)
            else:
                m.add(expr >= rhs if ge else expr <= rhs)
        else:
            w = SOFT_W.get(int(c.get("weight", 2)), 60)
            gap = m.new_int_var(0, 50, "")
            m.add(expr + gap >= rhs) if ge else m.add(expr <= rhs + gap)
            penalties.append((w, gap))

    for c in sc.get("conditions", []) or []:
        if c.get("on") is False or c.get("kind") == "memo":
            continue
        kind, cid = c.get("kind"), c.get("id")
        tg = targets(c)
        if kind == "sequence":
            pat = [token_codes(t) for t in c.get("pattern") or []]
            if not pat:
                continue
            for i in tg:
                Lp = len(P.staff[i].get("prev", []))
                for e in range(ND):
                    st = e - len(pat) + 1
                    if st < -Lp or not in_scope(c, e) or not P.employed[i][e]:
                        continue
                    cells = [(i, st + k) for k in range(len(pat))]
                    expr = sum(match(i, d, cs) for (i, d), cs in zip(cells, pat))
                    enforce(c, expr, len(pat) - 1, cells, {"type": "조건", "cond": cid, "staff": P.sid[i], "date": str(P.dates[e])})
        elif kind == "assign":
            codes = token_codes("|".join(c.get("codes") or []))
            only = c.get("mode") == "only"
            for i in tg:
                for d in range(ND):
                    if not in_scope(c, d) or not P.employed[i][d]:
                        continue
                    expr = match(i, d, codes)
                    if only:
                        enforce(c, expr, 1, [(i, d)], {"type": "조건", "cond": cid, "staff": P.sid[i], "date": str(P.dates[d])}, ge=True)
                    else:
                        enforce(c, expr, 0, [(i, d)], {"type": "조건", "cond": cid, "staff": P.sid[i], "date": str(P.dates[d])})
        elif kind == "conditional":
            # 조건부 제한: 그날 trigger 근무면 offset 일 뒤(음수면 전) target 근무 안 됨(not) / 만(only)
            trig = token_codes("|".join(c.get("trigger") or []))
            codes = token_codes("|".join(c.get("codes") or []))
            off = int(c.get("offset") or 1)
            only = c.get("mode") == "only"
            for i in tg:
                Lp = len(P.staff[i].get("prev", []))
                for d in range(-Lp, ND):
                    t = d + off
                    if not (0 <= t < ND) or not in_scope(c, t) or not P.employed[i][t]:
                        continue
                    a, b = match(i, d, trig), match(i, t, codes)
                    info = {"type": "조건", "cond": cid, "staff": P.sid[i], "date": str(P.dates[t])}
                    if only:
                        enforce(c, a - b, 0, [(i, d), (i, t)], info)
                    else:
                        enforce(c, a + b, 1, [(i, d), (i, t)], info)
        elif kind == "count":
            codes = token_codes("|".join(c.get("codes") or []))
            for i in tg:
                days = [d for d in range(ND) if in_scope(c, d) and P.employed[i][d]]
                cnt = sum(x[i, d, cc] for d in days for cc in codes)
                info = {"type": "조건", "cond": cid, "staff": P.sid[i]}
                cc = dict(c, level=c.get("level"))
                if c.get("max") not in (None, ""):
                    if c.get("level") == "금지":
                        elastic_le(cnt, int(c["max"]), HARD_W // 2, info)
                    else:
                        enforce(cc, cnt, int(c["max"]), [], info)
                if c.get("min") not in (None, ""):
                    if c.get("level") == "금지":
                        elastic_ge(cnt, int(c["min"]), HARD_W // 2, info)
                    else:
                        enforce(cc, cnt, int(c["min"]), [], info, ge=True)
        elif kind == "together":
            other = [P.idx[o] for o in c.get("other") or [] if o in P.idx]
            shifts = [s for s in (c.get("codes") or ["D", "E", "N", "소아"]) if s in WORK]
            apart = c.get("mode", "apart") == "apart"
            for d in range(ND):
                if not in_scope(c, d):
                    continue
                for a in tg:
                    for b in other:
                        if a == b:
                            continue
                        for sh in shifts:
                            info = {"type": "조건", "cond": cid, "staff": P.sid[a], "date": str(P.dates[d])}
                            if apart:
                                enforce(c, v(a, d, sh) + v(b, d, sh), 1, [(a, d), (b, d)], info)
                            else:
                                enforce(c, v(a, d, sh) - v(b, d, sh), 0, [(a, d), (b, d)], info)
                                enforce(c, v(b, d, sh) - v(a, d, sh), 0, [(a, d), (b, d)], info)

    for sh, w in (("N", 40), ("D", 8), ("E", 8)):
        hi, lo = m.new_int_var(0, ND, ""), m.new_int_var(0, ND, "")
        for i in fair:
            c = sum(x[i, d, sh] for d in range(ND))
            m.add(c <= hi)
            m.add(c >= lo)
        penalties.append((w, hi - lo))
    for key in ("pedsCharge", "pedsActing"):
        grp = [i for i in fair if roles[i].get(key)]
        if grp:
            hi, lo = m.new_int_var(0, ND, ""), m.new_int_var(0, ND, "")
            for i in grp:
                c = sum(x[i, d, "소아"] for d in range(ND))
                m.add(c <= hi)
                m.add(c >= lo)
            penalties.append((15, hi - lo))

    # 현재 번표를 힌트로 (재생성·부분 수정 시 빠르게). keepCurrent 면 바뀌는 칸마다 벌점 → 변경 최소화
    cur = sc.get("roster") or {}
    keep = int(sc.get("keepCurrent") or 0)
    for i, s in enumerate(P.staff):
        row = cur.get(s["id"]) or []
        for d, c in enumerate(row[:ND]):
            if c in CODES:
                m.add_hint(x[i, d, c], 1)
                if keep and (i, d) not in const:
                    penalties.append((keep, 1 - x[i, d, c]))

    m.minimize(sum(w * e for w, e in penalties) + sum(w * e for w, e, _ in relax))
    return m, x, relax, P


def solve(sc, time_limit=45, workers=None):
    """1단계: 금지 조건을 그대로 지키며 탐색. 해가 없으면 2단계: 금지 조건을 큰 벌점으로 바꿔 최소한만 어김."""
    t0 = time.time()
    st = None
    for strict, share in ((True, 0.6), (False, 1.0)):
        m, x, relax, P = _build(sc, strict)
        solver = cp_model.CpSolver()
        remain = float(time_limit) - (time.time() - t0)
        solver.parameters.max_time_in_seconds = max(5.0, remain * share if strict else remain)
        solver.parameters.num_workers = workers or max(2, min(8, os.cpu_count() or 2))
        st = solver.solve(m)
        if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
    secs = round(time.time() - t0, 1)
    if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"ok": False, "status": solver.status_name(st), "seconds": secs,
                "message": "조건을 모두 만족하는 번표를 찾지 못했습니다. 지정·잠금이 서로 모순되는지 확인하세요."}
    roster = {s["id"]: [next(c for c in CODES if solver.value(x[i, d, c])) for d in range(P.n_days)]
              for i, s in enumerate(P.staff)}
    relaxed = []
    for w, var, info in relax:
        k = solver.value(var)
        if k:
            relaxed.append({**info, "amount": k})
    return {"ok": True, "status": solver.status_name(st), "seconds": secs, "strict": strict,
            "objective": solver.objective_value, "roster": roster, "relaxed": relaxed}


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200, {"ok": True, "message": "POST {scenario, timeLimit} 로 호출하세요."})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            limit = min(max(float(req.get("timeLimit", 45)), 5), 270)
            self._send(200, solve(req["scenario"], limit))
        except Exception as e:  # noqa: BLE001 - 앱에 원인을 보여 준다
            self._send(400, {"ok": False, "message": f"요청 처리 오류: {e}"})
