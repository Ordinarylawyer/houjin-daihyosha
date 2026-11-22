// 法人の裁判上の代表者 判定 — Webアプリ（データは data/*.json。tools/build.py が作る）
// 判定の仕組みは tools/build.py の cond_ok / judge と同じ。
"use strict";

const REPO = "https://github.com/Ordinarylawyer/houjin-daihyosha";
const app = document.getElementById("app");
const stepEl = document.getElementById("step");

const S = {
  master: null, corps: null, koei: null, special: null,
  group: null,          // ホームで選んでいる区分
  type: null,           // 判定中の法人の種類
  answers: [],          // {q, a, label, cond, ord}
  ctx: {},              // 一覧から選んだもの {sl, corp, ke}
};

// ------------------------------------------------------------ 小道具
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (strings, ...vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? vals[i] : ""), "");
const setStep = (t) => { stepEl.textContent = t || ""; document.title = (t ? t + " — " : "") + "法人の裁判上の代表者 判定"; };
const go = (hash) => { if (location.hash === hash || (hash === "#" && !location.hash)) render(); else location.hash = hash; };

async function load(name) {
  const r = await fetch(`data/${name}.json`);
  if (!r.ok) throw new Error(`${name}.json を読み込めませんでした（${r.status}）`);
  return r.json();
}
function rowsOf(t) { return t.rows.map((r) => Object.fromEntries(t.cols.map((c, i) => [c, r[i]]))); }
async function need(name) {
  if (S[name]) return S[name];
  app.innerHTML = '<p class="loading">一覧を読み込んでいます…</p>';
  S[name] = rowsOf(await load(name));
  return S[name];
}

function reportUrl(target, title) {
  const p = new URLSearchParams({ template: "report.yml", title: "[報告] " + title, target });
  return `${REPO}/issues/new?${p}`;
}

// ------------------------------------------------------------ 判定エンジン（build.py と同じ規則）
function condOk(cond, ans) {
  if (!cond || !cond.trim()) return true;
  return cond.split("||").some((g) => g.split(";").every((c) => {
    if (!c.trim()) return true;
    const [k, v] = c.split("=");
    return v.split("|").map((x) => x.trim()).includes(ans[k.trim()] ?? "#");
  }));
}
const ansMap = () => Object.fromEntries(S.answers.map((a) => [a.q, a.a]));
function prune() {
  // 表示条件が成り立たなくなった回答を消す（連鎖するので 4 回）
  for (let i = 0; i < 4; i++) {
    const snap = ansMap();
    S.answers = S.answers.filter((a) => condOk(a.cond, snap));
  }
}
const typeQs = () => S.master.questions.filter((q) => q.type === S.type.code)
  .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));
const visibleQs = () => { const m = ansMap(); return typeQs().filter((q) => condOk(q.cond, m)); };
const choices = (q) => q.choices.split("|").filter((c) => c.includes("=")).map((c) => {
  const i = c.indexOf("="); return { code: c.slice(0, i), label: c.slice(i + 1) };
});
function setAnswer(q, code, label, cond, ord) {
  S.answers = S.answers.filter((a) => a.q !== q);
  S.answers.push({ q, a: code, label, cond: cond ?? "", ord: ord ?? 0 });
  prune();
}
const ans = (q) => S.answers.find((a) => a.q === q)?.a;

function judge() {
  const m = ansMap();
  const hits = S.master.rules.filter((r) => r.type === S.type.code && condOk(r.cond, m))
    .sort((a, b) => a.pri - b.pri);
  if (!hits.length) return null;
  let r = { ...hits[0] };
  const c = S.ctx.corp;
  // その他の法人を一覧から選んだときは、一覧の代表者・根拠条文で置き換える
  if (c) {
    if (["ET-L1", "ET-L3", "ET-L6"].includes(r.code)) {
      r = { ...r, rep: c.rep, basis: c.basis, docs: c.docs || r.docs, verified: c.src,
        note: (r.code === "ET-L3" ? r.note + "\n" : "") + c.note2 +
          (c.conf_rep ? (c.note2 ? "\n" : "") + "役員との訴訟・利益相反の場合：" + c.conf_rep : "") + "\n登記：" + c.reg };
    } else if (r.code === "ET-L4") {
      r = { ...r, rep: `根拠法に代表者との訴訟の特則は見当たりません（通常の代表者は ${c.rep}）`,
        basis: c.basis + "、民事訴訟法37条・35条", verified: c.src, docs: c.docs,
        note: (c.conf_rep ? "参考：" + c.conf_rep + "\n" : "") +
          "法人を代表する者自身が相手方となる場合は、根拠法が準用する一般法人法・会社法の規定（監事・社員総会等が" +
          "代表者を定める規定）の有無を確認し、なければ特別代理人の選任（民事訴訟法37条・35条）を検討してください。" };
    } else if (r.code === "ET-L5") {
      r = { ...r, basis: c.conf_rep, verified: c.src, note: r.note + `\n通常の代表者は ${c.rep}（${c.basis}）。` };
    } else if (["ET-L2", "ET-L7"].includes(r.code)) {
      const kanji = c.conf_rep.includes("監事");
      r = { ...r, rep: c.conf_rep, basis: c.conf_rep, kind: "代表者", verified: c.src,
        docs: kanji ? "法人の登記事項証明書（法人の存在と代表者の確認。監事は登記されないことが多い）、監事の選任（任命）を証する書面" +
            // 監事の代表が定款次第の法人は定款も要る（監査権限限定組合になりうる法人／定款で定めるところにより監事が代表する法人）
            (c.conf_rep.includes("監査権限限定") ? "、定款（監事の監査の範囲を会計に限定する定めの有無の確認。最新のもの）"
              : c.conf_rep.includes("定款で定めるところにより") ? "、定款（監事が代表する旨の定めの確認）" : "")
          : c.conf_rep.includes("特別代理人") ? "特別代理人選任決定（書）" : c.docs,
        note: `通常の代表者は ${c.rep}（${c.basis}）。` +
          (kanji ? "監事は登記されない法人が多いので、監事の選任を証する書面で確認してください。" : "") +
          (r.code === "ET-L7" ? "この特則は現在の代表者との利益相反事項に関するもので、役員であった者との訴えには及びません。" : "") };
    }
  }
  return r;
}
const choOf = () => ans("CH-K") ?? ans("KE-K");
const CHO = { P: "知事", C: "市長", T: "町長", V: "村長", W: "区長" };
function titleOf(r) {
  const { sl, corp, ke } = S.ctx;
  const t = S.type.code;
  if (t === "TK" && sl && ans("TK-K") === sl.kind) return sl.rep + (r.title.includes("職務代理者") ? "職務代理者" : "");
  if (["ET-L1", "ET-L3", "ET-L6"].includes(r.code)) return corp?.title ?? "";
  if (["ET-L2", "ET-L7"].includes(r.code)) {
    const cr = corp?.conf_rep ?? "";
    return cr.includes("監事") ? "監事" : cr.includes("特別代理人") ? "特別代理人" : "";
  }
  if (t === "KE" && ke && r.title.includes("事業管理者")) {
    if (ke.mname && ke.mname !== "（置かない）") return ke.mname;
    if (ke.jig.split("・").length === 1 && !ke.jig.startsWith("（")) return ke.jig + "事業管理者";
    return r.title;
  }
  return r.title.replace("{長}", CHO[choOf() ?? ans("TK-ZK")] ?? "長");
}
function corpDefault() {
  const { sl, corp, ke } = S.ctx;
  switch (S.type.code) {
    case "KU": return "国";
    case "TK": return sl?.name ?? "";
    case "ET": return S.answers.find((a) => a.q === "ET-KK")?.label ?? corp?.corp ?? "";
    case "KE": return ke?.dan ?? "";
    default: return "";
  }
}

// ------------------------------------------------------------ 画面: ホーム
function viewHome() {
  setStep("法人の種類");
  const types = [...S.master.types].sort((a, b) => a.order - b.order);
  const groups = [...new Set(types.map((t) => t.group))];
  if (!S.group) S.group = groups[0];
  app.innerHTML = h`
    <h1>法人の種類を選んでください</h1>
    <div class="tabs" role="group" aria-label="区分">${groups.map((g) =>
      `<button type="button" data-g="${esc(g)}" aria-pressed="${g === S.group}">${esc(g)}</button>`).join("")}</div>
    <ul class="list">${types.filter((t) => t.group === S.group).map((t) => h`
      <li><button type="button" class="row" data-t="${esc(t.code)}">
        <div class="name">${esc(t.name)}</div>
        <div class="sub">${esc(t.law)}${t.desc ? "　" + esc(t.desc) : ""}</div>
      </button></li>`).join("")}</ul>`;
  app.querySelectorAll("[data-g]").forEach((b) => b.onclick = () => { S.group = b.dataset.g; viewHome(); });
  app.querySelectorAll("[data-t]").forEach((b) => b.onclick = () => {
    const c = b.dataset.t;
    go(c === "TK" ? "#tk" : c === "ET" ? "#et" : c === "KE" ? "#ke" : `#t/${c}`);
  });
}

function startType(code, auto) {
  S.type = S.master.types.find((t) => t.code === code);
  S.answers = [];
  (auto || []).forEach((a) => S.answers.push(a));
  prune();
}

// ------------------------------------------------------------ 画面: 都道府県を選ぶ
function viewPrefs(title, base) {
  app.innerHTML = h`<h1>${esc(title)}</h1><p class="muted">都道府県を選んでください。</p>
    <div class="grid">${S.master.prefs.map((p) =>
      `<button type="button" data-p="${esc(p)}">${esc(p)}</button>`).join("")}</div>
    <div class="btns"><a class="btn" href="#">← 種類</a>
      <button type="button" class="btn" id="skip">一覧から選ばずに判定</button></div>`;
  app.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => go(`${base}/${encodeURIComponent(b.dataset.p)}`));
}

// ------------------------------------------------------------ 画面: 特別地方公共団体
const SL_KIND = { Z: "財産区", I: "一部事務組合", B: "一部事務組合（理事会）", E: "企業団", R: "広域連合", L: "広域連合（理事会）" };
const SL_KIND_LONG = { Z: "財産区", I: "一部事務組合（管理者を置くもの。規約上の名称が「組合長」等のものを含む）",
  B: "一部事務組合（管理者に代えて理事会を置くもの。地方自治法285条の組合）",
  E: "企業団（地方公営企業の経営を共同処理する一部事務組合）", R: "広域連合（長を置くもの）",
  L: "広域連合（長に代えて理事会を置くもの）", O: "その他（合併特例区など）" };
const SL_SRC = { A: "条例DBの規約で確認", a: "条例DBの規約から推定（要確認）", N: "未確認（規約をWeb等で確認してください）",
  P: "所在地から推定（財産区がある市町村の長）", L: "法律で定まる（企業団の管理者は企業長）" };
function slRep(s) {
  return { Z: s.muni + "長", I: "管理者", B: "理事長", E: "企業長", R: "広域連合長", L: "理事長" }[s.kind] ?? "（規約で確認）";
}
function skipTo(code) { S.ctx = {}; startType(code, code === "ET" ? [{ q: "ET-L", a: "O", label: "一覧にない法人", cond: "", ord: 10 }] : []); go(`#t/${code}`); }

async function viewSpecial(pref, no) {
  setStep("特別地方公共団体");
  if (!pref) { viewPrefs("特別地方公共団体", "#tk"); app.querySelector("#skip").onclick = () => skipTo("TK"); return; }
  const all = (await need("special")).filter((s) => s.pref === pref);
  const opts = {
    title: `特別地方公共団体（${pref}）`, back: "#tk", placeholder: "名称・市町村名で絞り込み", unit: "団体",
    rows: [...all].sort((a, b) => a.name.localeCompare(b.name, "ja")),
    match: (s, q) => s.name.includes(q) || s.muni.includes(q),
    name: (s) => s.name, sub: (s) => `${SL_KIND[s.kind] ?? "その他"}　代表: ${slRep(s)}`,
    href: (s) => `#tk/${encodeURIComponent(pref)}/${s.no}`,
  };
  if (!no) { splitView(opts, null); return; }
  const s = all.find((x) => x.no === no);
  if (!s) { go(`#tk/${encodeURIComponent(pref)}`); return; }
  const web = s.web ? s.web.slice(2) : "";
  const src = s.src[0];
  splitView(opts, (root) => {
    root.innerHTML = h`
      <a class="btn back-list" href="#tk/${encodeURIComponent(pref)}">← 一覧へ</a>
      <h1>${esc(s.name)}</h1>
      <p class="muted">${esc(SL_KIND[s.kind] ?? "その他")}　法人番号 ${esc(s.no)}<br>${esc(s.addr)}</p>
      <div class="card"><dl>
        <dt>代表者の資格</dt><dd><b>${esc(slRep(s))}</b>${s.alt ? `（規約上の名称は「${esc(s.alt)}」）` : ""}</dd>
        <dt>確認状態</dt><dd class="${"AL".includes(src) ? "ok" : "warn"}">${esc(SL_SRC[src] ?? s.src)}${
          s.web.startsWith("S") ? "／ウェブサイト: 検索で確認" : s.web.startsWith("P") ? "／関連ページ: 検索で確認" : ""}</dd>
      </dl></div>
      <div class="btns">
        <a class="btn" target="_blank" rel="noopener" href="https://jorei.slis.doshisha.ac.jp/search?simple=${encodeURIComponent(s.kind === "Z" ? s.name : s.name + " 規約")}">条例DBで規約</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.bing.com/search?q=${encodeURIComponent(s.name + " " + s.pref + (s.kind === "Z" ? " 財産区" : " 規約 " + slRep(s)))}">Webで検索</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.houjin-bangou.nta.go.jp/henkorireki-johoto.html?selHouzinNo=${esc(s.no)}">法人番号サイト</a>
        ${web ? `<a class="btn" target="_blank" rel="noopener" href="${esc(web)}">ウェブサイト</a>` : ""}
      </div>
      <div class="btns"><button type="button" class="btn primary" id="go">この団体で判定する →</button>
        <a class="btn small" target="_blank" rel="noopener" href="${esc(reportUrl(`特別地方公共団体 ${s.no} ${s.name}（${s.pref}）`, s.name))}">この団体の情報の誤りを報告</a></div>`;
    root.querySelector("#go").onclick = () => {
      const sl = { ...s, rep: slRep(s) };
      S.ctx = { sl };
      const auto = [{ q: "TK-K", a: s.kind, label: SL_KIND_LONG[s.kind] ?? "", cond: "", ord: 10 }];
      if (s.kind === "Z") {
        const zk = { 市: "C", 町: "T", 村: "V", 区: "W" }[s.muni.slice(-1)] ?? "C";
        auto.push({ q: "TK-ZK", a: zk, label: { C: "市", T: "町", V: "村", W: "特別区" }[zk], cond: "TK-K=Z", ord: 11 });
      }
      startType("TK", auto);
      go("#t/TK");
    };
  });

}

// 絞り込みできる一覧（共通）。o.el を渡すとその中に描く（広い画面の左側）
function listView(o) {
  const el = o.el ?? app;
  S.listQ ??= {};
  S.listTop ??= {};
  el.innerHTML = h`<h1>${esc(o.title)}</h1>
    <div class="searchbar"><input type="search" id="q" placeholder="${esc(o.placeholder)}" aria-label="${esc(o.placeholder)}">
      <span class="count" id="cnt"></span></div>
    <ul class="list" id="lst"></ul>
    <div class="btns"><a class="btn" href="${o.back}">← 戻る</a>${o.extra ?? ""}</div>`;
  const q = el.querySelector("#q"), lst = el.querySelector("#lst"), cnt = el.querySelector("#cnt");
  q.value = S.listQ[o.title] ?? "";
  const draw = () => {
    const k = q.value.trim();
    S.listQ[o.title] = q.value;
    const rows = k ? o.rows.filter((r) => o.match(r, k)) : o.rows;
    cnt.textContent = `${rows.length} ${o.unit}`;
    lst.innerHTML = rows.slice(0, 400).map((r) => {
      const href = o.href(r), cur = href === location.hash;
      return h`<li><a class="row${cur ? " active" : ""}"${cur ? ' aria-current="true"' : ""} style="display:block;text-decoration:none;color:inherit;padding:0.7em 0.9em" href="${href}">
      <div class="name">${esc(o.name(r))}</div><div class="sub">${esc(o.sub(r))}</div></a></li>`;
    }).join("") +
      (rows.length > 400 ? `<li class="muted" style="padding:0.6em 0.9em">先頭 400 件を表示しています。絞り込んでください。</li>` : "");
  };
  q.oninput = draw;
  draw();
  if (o.el) {  // 左の一覧のスクロール位置を、詳細を切り替えても保つ
    el.scrollTop = S.listTop[o.title] ?? 0;
    el.onscroll = () => { S.listTop[o.title] = el.scrollTop; };
  }
  o.after?.();
}

// 広い画面では左に一覧・右に詳細、狭い画面では一覧と詳細を別の画面にする
const WIDE = window.matchMedia("(min-width: 1100px)");
function splitView(opts, renderDetail) {
  if (!WIDE.matches) {
    if (renderDetail) renderDetail(app); else listView(opts);
    return;
  }
  app.innerHTML = '<div class="split"><section class="pane-l" id="paneL"></section><section class="pane-r" id="paneR"></section></div>';
  listView({ ...opts, el: app.querySelector("#paneL") });
  const r = app.querySelector("#paneR");
  if (renderDetail) renderDetail(r);
  else r.innerHTML = '<p class="muted pick">左の一覧から選ぶと、ここに詳細が出ます。</p>';
}
WIDE.addEventListener("change", () => { if (/^#(tk|et|ke)\//.test(location.hash) || location.hash === "#et") render(); });

// ------------------------------------------------------------ 画面: その他の法人
const ET_TK = { M: "役員（元役員を含む）との訴え等に特則", C: "現在の代表者との利益相反事項だけに特則",
  F: "社員との訴えに会社法601条", N: "訴訟の特則なし" };
async function viewCorp(code) {
  setStep("その他の法人");
  const all = await need("corps");
  const opts = {
    title: "その他の法人", back: "#", placeholder: "名称・根拠法・代表者で絞り込み", unit: "件", rows: all,
    match: (c, q) => c.name.includes(q) || c.law.includes(q) || c.rep.includes(q),
    name: (c) => c.name, sub: (c) => `${c.law}　代表: ${c.rep}`, href: (c) => `#et/${c.code}`,
    extra: '<button type="button" class="btn" id="skip">一覧にない法人として判定</button>',
    after: () => { app.querySelector("#skip").onclick = () => skipTo("ET"); },
  };
  if (!code) { splitView(opts, null); return; }
  const c = all.find((x) => x.code === code);
  if (!c) { go("#et"); return; }
  splitView(opts, (root) => {
    root.innerHTML = h`
      <a class="btn back-list" href="#et">← 一覧へ</a>
      <h1>${esc(c.name)}</h1>
      <p class="muted">${esc(c.grp_label)}　${esc(c.law)}</p>
      <div class="card"><dl>
        <dt>代表者</dt><dd><b>${esc(c.rep)}</b></dd>
        <dt>根拠条文</dt><dd>${esc(c.basis)}</dd>
        <dt>役員との訴訟・利益相反の場合</dt><dd>${esc(c.conf_rep || "（一覧に特則の記載なし）")}</dd>
        <dt>登記</dt><dd>${esc(c.reg)}</dd>
        <dt>確認資料</dt><dd>${esc(c.docs)}</dd>
        <dt>注記</dt><dd>${esc(c.note2 || "（なし）")}</dd>
        <dt>確認状態</dt><dd class="${c.src.startsWith("確認済") ? "ok" : "warn"}">${esc(c.src)}</dd>
      </dl></div>
      <div class="btns"><button type="button" class="btn primary" id="go">この法人で判定する →</button>
        <a class="btn small" target="_blank" rel="noopener" href="${esc(reportUrl(`その他の法人 ${c.code} ${c.name}`, c.name))}">この法人の情報の誤りを報告</a></div>`;
    root.querySelector("#go").onclick = () => {
      S.ctx = { corp: c };
      const kk = c.name === "国家公務員共済組合";
      const auto = [{ q: "ET-L", a: kk ? "K" : "L", label: `一覧から選んだ（${c.name}）`, cond: "", ord: 10 }];
      if (!kk) auto.push({ q: "ET-TK", a: c.conf_group || "N", label: ET_TK[c.conf_group || "N"], cond: "ET-L=L", ord: 11 });
      startType("ET", auto);
      go("#t/ET");
    };
  });

}

// ------------------------------------------------------------ 画面: 地方公営企業
async function viewKoei(pref, code) {
  setStep("地方公営企業");
  if (!pref) { viewPrefs("地方公営企業", "#ke"); app.querySelector("#skip").onclick = () => skipTo("KE"); return; }
  const all = (await need("koei")).filter((k) => k.pref === pref);
  const opts = {
    title: `地方公営企業（${pref}）`, back: "#ke", placeholder: "団体名・事業・条例名で絞り込み", unit: "件",
    rows: [...all].sort((a, b) => (a.kind === b.kind ? a.dan.localeCompare(b.dan, "ja") : a.kind === "P" ? -1 : 1)),
    match: (k, q) => k.dan.includes(q) || k.jig.includes(q) || k.title.includes(q),
    name: (k) => `${k.dan}　${k.jig}`, sub: (k) => `${k.rep}　${k.title}`,
    href: (k) => `#ke/${encodeURIComponent(pref)}/${k.code}`,
  };
  if (!code) { splitView(opts, null); return; }
  const k = all.find((x) => x.code === code);
  if (!k) { go(`#ke/${encodeURIComponent(pref)}`); return; }
  const jig1 = k.jig.startsWith("（") ? "" : k.jig.split("・")[0] + "事業";
  splitView(opts, (root) => {
    root.innerHTML = h`
      <a class="btn back-list" href="#ke/${encodeURIComponent(pref)}">← 一覧へ</a>
      <h1>${esc(k.dan)}　${esc(k.jig)}</h1>
      <p class="muted">${esc(k.title)}</p>
      <div class="card"><dl>
        <dt>裁判上の代表者</dt><dd><b>${esc(k.rep)}</b>（推定）${k.detail ? "　" + esc(k.detail) : ""}</dd>
        <dt>推定の根拠</dt><dd>${esc(k.basis)}</dd>
        <dt>確度</dt><dd class="${k.conf === "高" ? "ok" : "warn"}">${esc(k.conf)}</dd>
        ${k.mname ? `<dt>管理者の名称</dt><dd>${esc(k.mname)}（例規の題名・本文からの推定）</dd>` : ""}
        ${k.note ? `<dt>備考</dt><dd>${esc(k.note)}</dd>` : ""}
      </dl></div>
      <div class="btns">
        <a class="btn" target="_blank" rel="noopener" href="https://jorei.slis.doshisha.ac.jp/search?simple=${encodeURIComponent(k.title)}">条例DBで条例</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.bing.com/search?q=${encodeURIComponent(k.dan + " " + (jig1 || "公営企業") + " 管理者")}">Webで管理者</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.bing.com/search?q=${encodeURIComponent(k.pref + " " + k.dan + " " + jig1 + " 経営比較分析表")}">経営比較分析表</a>
      </div>
      <div class="btns"><button type="button" class="btn primary" id="go">この公営企業で判定する →</button>
        <a class="btn small" target="_blank" rel="noopener" href="${esc(reportUrl(`地方公営企業 ${k.code} ${k.dan}（${k.pref}）${k.jig}／${k.title}`, k.dan + " " + k.jig))}">この行の誤りを報告</a></div>`;
    root.querySelector("#go").onclick = () => {
      S.ctx = { ke: k };
      const ck = k.kind === "P" ? "P" : ({ 市: "C", 町: "T", 村: "V", 区: "W" }[k.dan.slice(-1)] ?? "C");
      const bk = k.rep === "管理者" ? "M" : k.rep === "長" ? "N" : "";
      const auto = [{ q: "KE-K", a: ck, label: { P: "都道府県", C: "市", T: "町", V: "村", W: "特別区" }[ck], cond: "", ord: 10 }];
      if (bk) auto.push({ q: "KE-BK", a: bk, label: bk === "M" ? "置いている"
        : "置いていない（条例で置かない、又は財務規定等だけを適用している）", cond: "", ord: 12 });
      startType("KE", auto);
      go("#t/KE");
    };
  });

}

// ------------------------------------------------------------ 画面: 要件に答える＋結果
function viewCheck(code) {
  if (!S.type || S.type.code !== code) {
    if (!S.master.types.some((t) => t.code === code)) { go("#"); return; }
    S.ctx = {};
    startType(code, code === "ET" ? [{ q: "ET-L", a: "O", label: "一覧にない法人", cond: "", ord: 10 }] : []);
  }
  setStep(S.type.name);
  const vis = visibleQs();
  const m = ansMap();
  const pending = vis.filter((q) => m[q.code] === undefined);
  const { sl, corp, ke } = S.ctx;
  const picked = sl ? `${sl.name}（${sl.pref}）` : corp ? corp.name : ke ? `${ke.dan}　${ke.jig}` : "";
  app.innerHTML = h`
    <h1>${esc(S.type.name)}</h1>
    <p class="muted">${esc(S.type.law)}${picked ? `<br>一覧から選んだもの：<b>${esc(picked)}</b>（その情報から答えた要件があります。違えば選び直してください）` : ""}</p>
    ${vis.length ? "" : '<p class="muted">この種類では答える要件はありません。</p>'}
    ${vis.map((q, i) => qView(q, i, m)).join("")}
    <div id="res"></div>
    <div class="btns"><a class="btn" href="${S.type.code === "TK" ? "#tk" : S.type.code === "ET" ? "#et" : S.type.code === "KE" ? "#ke" : "#"}">← 戻る</a>
      <button type="button" class="btn" id="reset">回答をすべて消す</button></div>`;
  app.querySelectorAll("input[type=radio]").forEach((inp) => inp.onchange = () => {
    const q = S.master.questions.find((x) => x.code === inp.name);
    setAnswer(q.code, inp.value, inp.dataset.label, q.cond, q.order);
    const y = window.scrollY;
    viewCheck(code);
    window.scrollTo(0, y);
    const next = app.querySelector(".q:not(.answered)");
    (next ?? app.querySelector("#res"))?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  app.querySelector("#reset").onclick = () => { S.ctx = {}; startType(code); viewCheck(code); };
  if (!pending.length) resultView(app.querySelector("#res"));
  else app.querySelector("#res").innerHTML = `<p class="notice">残り ${pending.length} 件の要件に答えると、判定結果を表示します。</p>`;
}
function qView(q, i, m) {
  const cur = m[q.code];
  const auto = S.answers.find((a) => a.q === q.code && !choices(q).some((c) => c.code === a.a));
  return h`<section class="q${cur !== undefined ? " answered" : ""}">
    <div class="qt">${i + 1}. ${esc(q.text)}</div>
    ${q.help ? `<details><summary>補足</summary>${esc(q.help)}</details>` : ""}
    <div class="opts" role="radiogroup" aria-label="${esc(q.text)}">${choices(q).map((c) => h`
      <label><input type="radio" name="${esc(q.code)}" value="${esc(c.code)}" data-label="${esc(c.label)}"${cur === c.code ? " checked" : ""}>
        <span>${esc(c.label)}</span></label>`).join("")}</div>
    ${auto ? `<p class="muted small">回答: ${esc(auto.label)}</p>` : ""}
  </section>`;
}

function resultView(el) {
  const r = judge();
  if (!r) {
    el.innerHTML = `<div class="result"><p class="kind k-none">該当なし</p><p>該当するルールがありません。回答を確認してください。</p></div>`;
    return;
  }
  const kindCls = r.kind === "代表者" ? "k-rep" : r.kind === "当事者適格" ? "k-party" : "k-none";
  const note = (r.note || "").replace("{長}", CHO[choOf()] ?? "知事等");
  const ansText = S.answers.slice().sort((a, b) => a.ord - b.ord)
    .map((a) => `${S.master.questions.find((q) => q.code === a.q)?.text ?? a.q} → ${a.label}`).join("\n");
  const target = `ルール ${r.code}（${S.type.name}）\n` +
    (S.ctx.sl ? `団体: ${S.ctx.sl.no} ${S.ctx.sl.name}\n` : "") + (S.ctx.corp ? `法人: ${S.ctx.corp.code} ${S.ctx.corp.name}\n` : "") +
    (S.ctx.ke ? `公営企業: ${S.ctx.ke.code} ${S.ctx.ke.dan} ${S.ctx.ke.jig}\n` : "") + "回答:\n" + ansText;
  el.innerHTML = h`<div class="result">
    <span class="meta">ルール ${esc(r.code)}　${esc(r.verified)}</span>
    <div class="kind ${kindCls}">${esc(r.kind || "該当なし")}</div>
    <div class="muted small">裁判上の代表者</div>
    <div class="rep">${esc(r.rep)}</div>
    <div class="card"><dl><dt>根拠条文</dt><dd>${esc(r.basis)}</dd></dl></div>
    <h2>当事者の表示例</h2>
    <div class="disp-in">
      <input type="text" id="d-role" value="被告" aria-label="地位">
      <input type="text" id="d-corp" value="${esc(corpDefault())}" placeholder="法人名" aria-label="法人名">
      <input type="text" id="d-title" value="${esc(titleOf(r))}" placeholder="資格" aria-label="資格">
      <input type="text" id="d-name" value="" placeholder="氏名" aria-label="氏名">
    </div>
    <div class="disp" id="disp"></div>
    <div class="btns"><button type="button" class="btn" id="copy">表示例をコピー</button></div>
    <h2>注記</h2><div class="card"><dd style="white-space:pre-wrap;margin:0">${esc(note || "（なし）")}</dd></div>
    <h2>確認する資料</h2><div class="card"><dd style="white-space:pre-wrap;margin:0">${esc(r.docs || "（特になし）")}</dd></div>
    <div class="btns"><a class="btn small" target="_blank" rel="noopener" href="${esc(reportUrl(target, `${S.type.name}（${r.code}）`))}">この判定の誤りを報告する</a></div>
  </div>`;
  const $ = (id) => el.querySelector("#" + id);
  const draw = () => {
    const corp = $("d-corp").value || "〇〇";
    $("disp").textContent = (r.tmpl || "")
      .replace(/\{長職名\}/g, corp + (choOf() === "P" ? "知事" : "長"))
      .replace(/\{地位\}/g, $("d-role").value).replace(/\{法人名\}/g, corp)
      .replace(/\{資格\}/g, $("d-title").value).replace(/\{氏名\}/g, $("d-name").value || "〇〇");
  };
  ["d-role", "d-corp", "d-title", "d-name"].forEach((id) => $(id).oninput = draw);
  draw();
  $("copy").onclick = async () => {
    try { await navigator.clipboard.writeText($("disp").textContent); $("copy").textContent = "コピーしました"; }
    catch { $("copy").textContent = "コピーできませんでした"; }
    setTimeout(() => { $("copy").textContent = "表示例をコピー"; }, 2000);
  };
}

// ------------------------------------------------------------ ルーティング
async function render() {
  const parts = location.hash.replace(/^#/, "").split("/").map(decodeURIComponent);
  try {
    switch (parts[0]) {
      case "t": viewCheck(parts[1]); break;
      case "tk": await viewSpecial(parts[1], parts[2]); break;
      case "et": await viewCorp(parts[1]); break;
      case "ke": await viewKoei(parts[1], parts[2]); break;
      default: viewHome();
    }
  } catch (e) {
    app.innerHTML = `<p class="notice">エラー: ${esc(e.message)}</p>`;
  }
  if ((!parts[0] || parts[0] !== "t") && !app.querySelector(".split")) window.scrollTo(0, 0);
}
window.addEventListener("hashchange", render);
document.getElementById("home-link").onclick = (e) => { e.preventDefault(); go("#"); };

(async () => {
  try {
    S.master = await load("master");
    document.getElementById("built").textContent = `データ ${S.master.built}`;
    render();
  } catch (e) {
    app.innerHTML = `<p class="notice">データを読み込めませんでした: ${esc(e.message)}</p>`;
  }
})();
