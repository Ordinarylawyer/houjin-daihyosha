# -*- coding: utf-8 -*-
"""
判定ルールの原本（tools/rules_src.py ほか）と一覧データ（data/*.csv）から、
検査・一覧（docs/07）・CSV（seed/）・Webアプリ用 JSON（site/data/）を作る。

    uv run tools/build.py          # 全部作る（検査でエラーがあれば終了コード 1）
    uv run tools/build.py --check  # 検査だけ

出力
  tests/検査結果.txt   … 検査結果
  docs/07_判定ルール一覧.md … 人が読む一覧（全回答パターンの結論付き）
  seed/*.csv           … 法人種別・質問・ルール・その他の法人・地方公営企業（UTF-8 BOM）
  site/data/*.json     … Webアプリが読むデータ（コミットしない。GitHub Actions が作る）
"""
import csv
import itertools
import os
import sys
from collections import defaultdict

sys.dont_write_bytecode = True  # __pycache__ を作らない
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import rules_src as S  # noqa: E402

TYPES = sorted(S.TYPES, key=lambda t: t["order"])
QS = S.QUESTIONS
RS = S.RULES


# ------------------------------------------------------------ 判定エンジン（アプリと同じ規則）
def parse_group(g):
    out = []
    for c in g.split(";"):
        c = c.strip()
        if not c:
            continue
        k, v = c.split("=", 1)
        out.append((k.strip(), [x.strip() for x in v.split("|")]))
    return out


def parse_cond(cond):
    """全グループの (質問, 値) を平らにして返す（検査用）"""
    return [kv for g in (cond or "").split("||") for kv in parse_group(g)]


def cond_ok(cond, answers):
    """空なら真。|| で区切ったグループのどれかで、; の全項目が成立すれば真"""
    if not (cond or "").strip():
        return True
    return any(all(answers.get(k, "#") in vals for k, vals in parse_group(g))
               for g in cond.split("||"))


def visible(qs, answers):
    return [q for q in qs if cond_ok(q["cond"], answers)]


def choices(q):
    return [c.split("=", 1) for c in q["choices"].split("|")]


def judge(rules, answers):
    hits = [r for r in rules if cond_ok(r["cond"], answers)]
    hits.sort(key=lambda r: r["pri"])
    return hits


def paths(qs):
    """全回答パターンを列挙（順序どおりに答えた場合）"""
    qs = sorted(qs, key=lambda q: (q["order"], q["code"]))

    def rec(ans):
        nxt = next((q for q in visible(qs, ans) if q["code"] not in ans), None)
        if nxt is None:
            yield dict(ans)
            return
        for k, _ in choices(nxt):
            ans[nxt["code"]] = k
            yield from rec(ans)
            del ans[nxt["code"]]

    yield from rec({})


# ------------------------------------------------------------ 検査
def check():
    errs, warns, lines = [], [], []
    tcodes = {t["code"] for t in TYPES}
    qmap = {q["code"]: q for q in QS}
    codes = [q["code"] for q in QS] + [r["code"] for r in RS] + [t["code"] for t in TYPES]
    for c in set(codes):
        if codes.count(c) > 1:
            errs.append(f"コード重複: {c}")
    for r in RS:
        if "||" in r["cond"]:
            errs.append(f"{r['code']}: ルールの成立条件に || は使えない（ルールを分ける）")
    for x in QS + RS:
        if x["type"] not in tcodes:
            errs.append(f"{x['code']}: 種別コード {x['type']} がない")
        for k, vals in parse_cond(x["cond"]):
            q = qmap.get(k)
            if q is None:
                errs.append(f"{x['code']}: 条件の質問 {k} がない")
                continue
            ok = {c for c, _ in choices(q)}
            for v in vals:
                if v not in ok:
                    errs.append(f"{x['code']}: 条件 {k}={v} は選択肢にない")
            if x in QS and q["order"] >= x["order"]:
                errs.append(f"{x['code']}: 表示条件が後ろの質問 {k} を参照している")
    for x in QS:
        for s in (x["choices"], x["cond"]):
            if any(ch in s for ch in ['"']):
                errs.append(f"{x['code']}: 使えない文字（\"）")
        for c in x["choices"].split("|"):
            if c.count("=") != 1 or ";" in c:
                errs.append(f"{x['code']}: 選択肢の書式 {c}")
    stats = {}
    for t in TYPES:
        qs = [q for q in QS if q["type"] == t["code"]]
        rs = [r for r in RS if r["type"] == t["code"]]
        used = set()
        n = 0
        for a in paths(qs):
            n += 1
            h = judge(rs, a)
            if not h:
                errs.append(f"{t['code']}: 該当ルールなし {a}")
                continue
            used.add(h[0]["code"])
            if len(h) > 1 and h[0]["pri"] == h[1]["pri"]:
                errs.append(f"{t['code']}: 同じ優先順位で複数該当 {h[0]['code']},{h[1]['code']} {a}")
        for r in rs:
            if r["code"] not in used:
                errs.append(f"{r['code']}: どの回答パターンでも最優先にならない（死にルール）")
        stats[t["code"]] = (len(qs), len(rs), n)
    return errs, warns, stats


def simulate(seed=1, steps=3000):
    """アプリの動き（回答→表示条件の外れた回答を 4 回消す→次の質問）を乱数で再現し、
    画面に残る回答が「順に答えた場合」と同じ結論になるかを確かめる"""
    import random
    rnd = random.Random(seed)
    errs = []
    for t in TYPES:
        qs = sorted([q for q in QS if q["type"] == t["code"]], key=lambda q: (q["order"], q["code"]))
        rs = [r for r in RS if r["type"] == t["code"]]
        if not qs:
            continue
        ans = {}
        for _ in range(steps):
            vis = visible(qs, ans)
            q = rnd.choice(vis)                      # 一覧のどの要件でも選び直せる
            ans[q["code"]] = rnd.choice(choices(q))[0]
            for _ in range(4):                      # アプリの RemoveIf を 4 回
                snap = dict(ans)
                for k in list(ans):
                    if not cond_ok(next(x for x in qs if x["code"] == k)["cond"], snap):
                        del ans[k]
            vis = visible(qs, ans)
            if any(k not in {x["code"] for x in vis} for k in ans):
                errs.append(f"{t['code']}: 表示されない質問の回答が残った {ans}")
                break
            if all(x["code"] in ans for x in vis):
                h = judge(rs, ans)
                if not h:
                    errs.append(f"{t['code']}: 判定不能 {ans}")
                    break
    return errs


# ------------------------------------------------------------ 出力
def write_csv(path, header, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_ALL)
        w.writerow(header)
        w.writerows(rows)


T_COLS = [("コード", "code"), ("名称", "name"), ("区分", "group"), ("根拠法令", "law"), ("表示順", "order"),
          ("説明", "desc")]
Q_COLS = [("コード", "code"), ("種別コード", "type"), ("表示順", "order"), ("質問文", "text"), ("補足", "help"),
          ("選択肢", "choices"), ("表示条件", "cond")]
R_COLS = [("コード", "code"), ("種別コード", "type"), ("優先順位", "pri"), ("成立条件", "cond"), ("結論", "rep"),
          ("資格表示", "title"), ("根拠条文", "basis"), ("表示例", "tmpl"), ("確認資料", "docs"), ("注記", "note"),
          ("結果区分", "kind"), ("検証状態", "verified")]




def write_list(path, stats):
    L = ["# 07 判定ルール一覧（自動生成）", "",
         "> `tools/build.py` が `tools/rules_src.py` から生成します。手で直さず、原本を直して再生成してください。",
         "> 「回答パターンと結論」は、質問に順に答えたときの全パターンと、最優先で当たるルールです。", ""]
    groups = defaultdict(list)
    for t in TYPES:
        groups[t["group"]].append(t)
    L.append("## 目次\n")
    for g, ts in groups.items():
        L.append(f"- {g}: " + "、".join(f"{t['name']}（{t['code']}）" for t in ts))
    L.append("")
    for t in TYPES:
        qs = sorted([q for q in QS if q["type"] == t["code"]], key=lambda q: (q["order"], q["code"]))
        rs = sorted([r for r in RS if r["type"] == t["code"]], key=lambda r: r["pri"])
        nq, nr, np_ = stats[t["code"]]
        L.append(f"## {t['name']}（{t['code']}）")
        L.append(f"\n根拠法令: {t['law']}　／　質問 {nq}・ルール {nr}・回答パターン {np_}\n")
        if t["desc"]:
            L.append(f"{t['desc']}\n")
        L.append("### 質問（要件）\n")
        L.append("| コード | 質問 | 選択肢 | 表示条件 |")
        L.append("|---|---|---|---|")
        for q in qs:
            ch = "<br>".join(f"{k}: {v}" for k, v in choices(q))
            L.append(f"| {q['code']} | {q['text']} | {ch} | {q['cond'] or '常に'} |")
        L.append("\n### ルール\n")
        L.append("| 優先 | コード | 成立条件 | 結論 | 根拠条文 | 区分 | 検証 |")
        L.append("|---|---|---|---|---|---|---|")
        for r in rs:
            L.append(f"| {r['pri']} | {r['code']} | {r['cond'] or '常に'} | {r['rep']} | {r['basis']} | "
                     f"{r['kind']} | {r['verified']} |")
        L.append("\n### 回答パターンと結論\n")
        L.append("| 回答 | 結論 | ルール |")
        L.append("|---|---|---|")
        for a in paths(qs):
            h = judge(rs, a)
            ans = "、".join(f"{k.split('-', 1)[1]}={v}" for k, v in a.items()) or "（質問なし）"
            L.append(f"| {ans} | {h[0]['rep'] if h else '**該当なし**'} | {h[0]['code'] if h else ''} |")
        L.append("")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L))


# ------------------------------------------------------------ 特別地方公共団体の一覧
PREFS = ("北海道,青森県,岩手県,宮城県,秋田県,山形県,福島県,茨城県,栃木県,群馬県,埼玉県,千葉県,東京都,神奈川県,"
         "新潟県,富山県,石川県,福井県,山梨県,長野県,岐阜県,静岡県,愛知県,三重県,滋賀県,京都府,大阪府,兵庫県,"
         "奈良県,和歌山県,鳥取県,島根県,岡山県,広島県,山口県,徳島県,香川県,愛媛県,高知県,福岡県,佐賀県,長崎県,"
         "熊本県,大分県,宮崎県,鹿児島県,沖縄県").split(",")


def special_rows():
    """data/特別地方公共団体一覧.csv のうち、閉鎖していないもの"""
    path = os.path.join(ROOT, "data", "特別地方公共団体一覧.csv")
    with open(path, encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if "閉鎖" not in r["備考"]]
    rows.sort(key=lambda r: (PREFS.index(r["都道府県"]), r["種類"] != "Z", r["市区町村"], r["名称"]))
    return rows


def web_map():
    """data/特別地方公共団体_ウェブサイト.csv（検索で確認したウェブサイト）→ {法人番号: "S:URL" / "P:URL"}"""
    path = os.path.join(ROOT, "data", "特別地方公共団体_ウェブサイト.csv")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8-sig") as f:
        return {r["法人番号"]: r["区分"] + ":" + r["URL"] for r in csv.DictReader(f) if r["区分"] in ("S", "P")}



# ------------------------------------------------------------ その他の法人
C_COLS = [("コード", "code"), ("区分", "grp_label"), ("名称", "name"), ("根拠法", "law"), ("代表者", "rep"),
          ("資格", "title"), ("代表根拠", "basis"), ("特則", "conf_rep"), ("特則の型", "conf_group"), ("登記", "reg"),
          ("確認資料", "docs"), ("注記", "note2"), ("確認状態", "src"), ("法人名", "corp")]


def corp_rows():
    import build_catalog
    rows = build_catalog.catalog_rows()
    for r in rows:
        r["note2"] = "／".join(x for x in (r["other"], r["note"]) if x)
    return rows


# ------------------------------------------------------------ 地方公営企業
K_COLS = [("コード", "code"), ("都道府県", "pref"), ("団体", "dan"), ("団体区分", "kind"), ("条例名", "title"),
          ("事業", "jig"), ("置かない規定", "okanai"), ("全部適用", "zenbu"), ("代表者", "rep"), ("事業別", "detail"),
          ("根拠", "basis"), ("確度", "conf"), ("備考", "note"), ("管理者の名称", "mname"), ("確認状態", "src")]


def koei_rows():
    """data/地方公営企業_設置条例一覧.csv（tools/koei_build.py が作る）のうち設置条例"""
    path = os.path.join(ROOT, "data", "地方公営企業_設置条例一覧.csv")
    with open(path, encoding="utf-8-sig") as f:
        src = [r for r in csv.DictReader(f) if r["区分"] == "設置条例"]
    out = []
    for i, r in enumerate(src, 1):
        out.append(dict(code=f"KE{i:05d}", pref=r["都道府県"], dan=r["団体"],
                        kind="P" if r["団体区分"] == "都道府県" else "M",
                        title=r["条例名"], jig=r["事業"], okanai=r["管理者を置かない規定"], zenbu=r["全部適用の規定"],
                        rep=r["代表者の推定"], detail=r["事業別"], basis=r["推定の根拠"], conf=r["確度"],
                        note=r["備考"][:200],
                        # 例規の題名から推定した管理者の名称（tools/koei_names.py）。確認状態 T: は「題名からの推定」
                        mname=r.get("管理者の名称", ""), src="T:例規の題名" if r.get("管理者の名称") else ""))
    return out



# ------------------------------------------------------------ Webアプリ用 JSON
def write_json(name, obj):
    import json
    d = os.path.join(ROOT, "site", "data")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, name), "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def write_web(crows, krows):
    import datetime
    write_json("master.json", {
        "built": datetime.date.today().isoformat(),
        "types": [{k: t[k] for k in ("code", "name", "group", "law", "order", "desc")} for t in TYPES],
        "questions": [{k: q[k] for k in ("code", "type", "order", "text", "help", "choices", "cond")} for q in QS],
        "rules": [{k: r[k] for k in ("code", "type", "pri", "cond", "rep", "title", "basis", "tmpl", "docs", "note",
                                     "kind", "verified")} for r in RS],
        "prefs": PREFS,
    })
    # 配列で持つ（キー名の繰り返しを省いてファイルを小さくする）。列の並びは各 JSON の "cols"
    keys = [k for _, k in C_COLS]
    write_json("corps.json", {"cols": keys, "rows": [[r[k] for k in keys] for r in crows]})
    keys = [k for _, k in K_COLS]
    write_json("koei.json", {"cols": keys, "rows": [[r[k] for k in keys] for r in krows]})
    web = web_map()
    srows = special_rows()
    keys = ["no", "name", "pref", "muni", "kind", "src", "alt", "addr", "web"]
    write_json("special.json", {"cols": keys, "rows": [
        [r["法人番号"], r["名称"], r["都道府県"], r["市区町村"], r["種類"], r["確認状態"], r["規約上の名称"],
         r["所在地"], web.get(r["法人番号"], "")] for r in srows]})
    return len(srows)


def main():
    errs, warns, stats = check()
    errs += simulate()
    os.makedirs(os.path.join(ROOT, "tests"), exist_ok=True)
    total_p = sum(s[2] for s in stats.values())
    rep = [f"種別 {len(TYPES)}・質問 {len(QS)}・ルール {len(RS)}・回答パターン {total_p}",
           f"要確認のルール {sum(1 for r in RS if r['verified'] == '要確認')} 件", ""]
    rep += [f"{c}: 質問 {a}・ルール {b}・パターン {n}" for c, (a, b, n) in stats.items()]
    rep += ["", f"エラー {len(errs)} 件"] + errs + [f"警告 {len(warns)} 件"] + warns
    with open(os.path.join(ROOT, "tests", "検査結果.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(rep) + "\n")
    print("\n".join(rep[:2] + rep[-(len(errs) + len(warns) + 2):]))
    if "--check" in sys.argv:
        sys.exit(1 if errs else 0)

    write_csv(os.path.join(ROOT, "seed", "01_法人種別.csv"), [c for c, _ in T_COLS],
              [[t[k] for _, k in T_COLS] for t in TYPES])
    write_csv(os.path.join(ROOT, "seed", "02_質問.csv"), [c for c, _ in Q_COLS],
              [[q[k] for _, k in Q_COLS] for q in QS])
    write_csv(os.path.join(ROOT, "seed", "03_ルール.csv"), [c for c, _ in R_COLS],
              [[r[k] for _, k in R_COLS] for r in RS])
    write_list(os.path.join(ROOT, "docs", "07_判定ルール一覧.md"), stats)
    import build_catalog
    build_catalog.write_csv()  # data/法人一覧_調査.csv（その他の法人の一覧。人が読む用）
    crows = corp_rows()
    write_csv(os.path.join(ROOT, "seed", "05_個別法人.csv"), [c for c, _ in C_COLS],
              [[r[k] for _, k in C_COLS] for r in crows])
    krows = koei_rows()
    write_csv(os.path.join(ROOT, "seed", "06_公営企業.csv"), [c for c, _ in K_COLS],
              [[r[k] for _, k in K_COLS] for r in krows])
    ns = write_web(crows, krows)
    print(f"その他の法人 {len(crows)} 件・地方公営企業 {len(krows)} 件・特別地方公共団体 {ns} 件 → site/data/")
    sys.exit(1 if errs else 0)


if __name__ == "__main__":
    main()
