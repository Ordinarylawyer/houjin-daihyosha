# -*- coding: utf-8 -*-
"""corp_catalog_src.py（個別法人の調査ソース）から
  - data/法人一覧_調査.csv（人が読む一覧）
  - catalog_rows()（アプリのマスタ「代表者判定_個別法人」に入れる行。build.py が使う）
を作る。単独で実行すると CSV だけ書き出す。
"""
import csv
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

GRP = [  # (区分の内部名, アプリで表示する短い名称, コードの頭文字)
    ("MUTOKI", "登記しない法人", "M"),
    ("DOKUHO", "独法等登記令の法人", "D"),
    ("KUMIAI", "組合等登記令の法人", "K"),
    ("JIKO", "根拠法で登記する法人", "J"),
    ("ADMIN", "管理処分中の法人", "X"),
    ("ZAISAN", "法律上当然に成立する財産の法人", "Z"),
]
GRP_LABEL = {k: v for k, v, _ in GRP}
GRP_PREFIX = {k: c for k, _, c in GRP}
CSV_LABEL = {"MUTOKI": "登記なし", "DOKUHO": "独立行政法人等登記令（別表）", "KUMIAI": "組合等登記令（別表）",
             "JIKO": "根拠法に登記規定", "ADMIN": "管理処分中の特例",
             "ZAISAN": "法律上当然に成立（財産の法人）"}

# 法人名がそのまま 1 つに決まるもの（表示例の法人名に入れる）
UNIQUE = {"日本弁護士連合会", "日本商工会議所", "農林中央金庫", "中央職業能力開発協会", "原子力発電環境整備機構",
          "使用済燃料再処理・廃炉推進機構", "健康保険組合連合会", "企業年金連合会", "国民年金基金連合会"}


def title_of(rep):
    """代表者の欄から、表示例の「同代表者○○」に入れる資格を決める"""
    for t in ("理事長", "会長", "会頭", "総裁", "社長", "委員長", "代表理事", "代表取締役", "執行役員", "相続財産清算人",
              "信託財産法人管理人", "代表者", "金融整理管財人", "預金保険機構", "保険管理人", "管理人"):
        if rep.startswith(t):
            return t
    if rep.startswith(("組合を代表する理事", "酒類業組合を代表する理事")):
        return "代表理事"
    if "社員" in rep:
        return "代表社員"
    if rep.startswith("理事"):
        return "理事"
    return ""  # 各省各庁の長・要確認など（利用者が入れる）


def _law(basis):
    return re.split(r"\d|（", basis)[0]


def _load():
    ns = {}
    with open(os.path.join(HERE, "corp_catalog_src.py"), encoding="utf-8") as f:
        exec(f.read(), ns)
    return ns


def catalog_rows():
    ns = _load()
    out = []

    def add(g, name, law, rep, basis, conf, reg, docs, note, ok, day="2026-11-20"):
        out.append(dict(grp=g, name=name, law=law, rep=rep, basis=basis, conf=conf, reg=reg, docs=docs,
                        note=note, src=f"確認済（{day}）" if ok else "要確認"))

    for r in ns["ROWS"]:
        if r["grp"] != "MUTOKI":
            continue
        add("MUTOKI", r["name"], r["law"], r["rep"], r["rep_b"], r["conflict"], r["reg"], r["docs"], r["note"],
            r["ok"], r["day"])
    for name, law in ns["DOKUHO_TABLE"]:
        rep, basis, conf = ns["DOKUHO_REP"].get(name, ("（要確認）", "", ""))
        add("DOKUHO", name, law, rep, basis, conf, "独立行政法人等登記令",
            "登記事項証明書（代表権を有する者が登記される）", "", "要確認" not in rep + basis)
    for g, key in (("KUMIAI", "KUMIAI_REP"), ("JIKO", "JIKO_REP")):
        for name, (rep, basis, conf, reg) in ns[key].items():
            add(g, name, _law(basis), rep, basis, conf, reg,
                "登記事項証明書（代表権を有する者が登記される）", "", "要確認" not in rep + basis)
    for name, rep, basis in ns["SPECIAL_ADMIN"]:
        add("ADMIN", name, _law(basis), rep, basis, "", "管理を命ずる処分は登記・公告される",
            "管理を命ずる処分の決定書・公告、登記事項証明書", "業務の執行・財産の管理処分の権限（代表権）が専属する", True)
    # 2026-11-21 に追加した行（ROWS のうち MUTOKI 以外の区分）。既存行のコードを動かさないよう最後に並べる
    for r in ns["ROWS"]:
        if r["grp"] != "MUTOKI":
            add(r["grp"], r["name"], r["law"], r["rep"], r["rep_b"], r["conflict"], r["reg"], r["docs"], r["note"], r["ok"],
                r["day"])

    cnt = {}
    for r in out:
        r["title"] = title_of(r["rep"])
        r["corp"] = r["name"] if (r["grp"] == "DOKUHO" or r["name"] in UNIQUE) else ""
        r["grp_label"] = GRP_LABEL[r["grp"]]
        # 「他の代表権者」の注記と、役員との訴訟・利益相反時の代表者（特則）を分ける
        parts = [p for p in r["conf"].split("／") if p]
        special = [p for p in parts if "：" in p or p.startswith("監事")]
        r["conf_rep"] = "／".join(special)
        r["other"] = "／".join(p for p in parts if p not in special)
        p = GRP_PREFIX[r["grp"]]
        cnt[p] = cnt.get(p, 0) + 1
        r["code"] = f"{p}{cnt[p]:03d}"
    # 役員との訴訟・利益相反の特則（docs/14。tools/corp_special.py）で置き換え、協同組合型は一覧から外す
    sp = {}
    with open(os.path.join(HERE, "corp_special.py"), encoding="utf-8") as f:
        exec(f.read(), sp)
    keep = []
    for r in out:
        if r["code"] in sp["MOVED"]:
            continue
        tp, txt, basis = sp["P"].get(r["code"], ("N", "", ""))
        r["conf_type"] = tp
        r["conf_group"] = sp["GROUP"][tp]
        r["conf_rep"] = "" if tp == "N" else (f"{txt}（{basis}）" if basis else txt)
        if tp == "B3":
            r["conf_rep"] = f"{txt}（{basis}）"
        keep.append(r)
    return keep


def write_csv():
    rows = catalog_rows()
    hdr = ["コード", "区分", "法人種別", "根拠法", "代表者", "表示例の資格", "代表者の根拠条文", "他の代表権者",
           "役員との訴訟・利益相反時の代表者", "特則の型", "登記", "確認資料", "注記", "確認状態"]
    with open(os.path.join(ROOT, "data", "法人一覧_調査.csv"), "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(hdr)
        for r in rows:
            w.writerow([r["code"], CSV_LABEL[r["grp"]], r["name"], r["law"], r["rep"], r["title"], r["basis"],
                        r["other"], r["conf_rep"], r["conf_type"], r["reg"], r["docs"], r["note"], r["src"]])
    return rows


if __name__ == "__main__":
    from collections import Counter
    rows = write_csv()
    print(len(rows), Counter(r["grp"] for r in rows), Counter(r["src"] for r in rows))
    for r in rows:
        if r["src"] == "要確認":
            print("  要確認:", r["name"])
