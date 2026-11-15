// Help: step-by-step tour, "explain what I click" mode and how-to topics
"use strict";

(() => {
const $ = (s) => document.querySelector(s);

// Tour steps: element (CSS selector), title, text. Steps whose element is hidden are skipped.
const STEPS = [
  { sel: "#homeBtn", title: "Moje knihy", text: "Návrat na úvodní stránku. Tam vyberete knihu, kterou píšete, založíte novou, vyplníte její nastavení a tiráž, nebo otevřete zdrojovou knihu." },
  { sel: ".cols-toggle", title: "Sloupce", text: "Tlačítky zapínáte a vypínáte sloupce: <b>Originál</b> (sken), <b>Transkripce</b> (text ze skenu), <b>Rukopis</b> (vaše kniha), <b>Dotaz</b> (otázky na knihy) a <b>Obrázky</b>. Zapnuté tlačítko je modré." },
  { sel: ".presets", title: "Rychlé rozložení", text: "Tři nejčastější rozložení na jedno kliknutí. Například <b>Píšu s citacemi</b> dá vedle sebe transkripci a rukopis." },
  { sel: ".search-wrap", title: "Hledání", text: "Napište slovo a aplikace ho najde ve všech knihách i v rukopisu. Při psaní nabízí návrhy. Kliknutím na výsledek se na místo přesunete." },
  { sel: "#uiBigger", title: "Velikost písma", text: "<b>A+</b> a <b>A−</b> zvětší nebo zmenší písmo i tlačítka v celé aplikaci. Nastavení si aplikace pamatuje." },
  { sel: "#bookNav", title: "Výběr knihy a stránky", text: "Nahoře vyberete knihu, šipkami listujete stránkami. Náhledy stránek jsou pod tím, kliknutím stránku otevřete." },
  { sel: "#colScan", title: "Originál", text: "Naskenovaná stránka. Kolečkem nebo tlačítky ji zvětšíte. Rámeček kolem obrázku můžete tahem upravit a obrázek tím přesněji vyříznout." },
  { sel: "#colText", title: "Transkripce", text: "Text přečtený ze skenu. Opravujte ho přímo v textu. Pod každým odstavcem je tlačítko <b>Do rukopisu</b> (přenese text) a <b>Jako citace</b> (vloží ho jako citaci se zdrojem)." },
  { sel: "#fmtBar", title: "Formát transkripce", text: "Klikněte do odstavce a tady zvolíte, zda je to nadpis, citace nebo poznámka, a nastavíte tučné písmo či zarovnání." },
  { sel: "#msTitle", title: "Název knihy", text: "Název vaší knihy. Použije se na titulní straně a v e-knize." },
  { sel: "#colMs", title: "Rukopis", text: "Vaše vlastní kniha. Píše se jako ve Wordu, ukládá se sama každých pár vteřin. Nahoře vpravo vidíte, kdy se naposledy uložila." },
  { sel: "#insertBtn", title: "Vložit obsah a zlom strany", text: "Vloží <b>automatický obsah</b>, který se sám doplňuje podle kapitol, nebo <b>zlom strany</b> pro tisk a PDF." },
  { sel: "#msDrawerBtn", title: "Obsah a schránka", text: "Otevře obsah rukopisu (kapitoly, kliknutím na ně skočíte) a schránku s texty a obrázky, které jste si odložili." },
  { sel: "#snapshotBtn", title: "Verze", text: "Uloží pojmenovanou verzi rukopisu, třeba „před úpravou kapitoly 3“. Kdykoli se k ní můžete vrátit." },
  { sel: "#historyBtn", title: "Historie", text: "Všechny dřívější verze rukopisu. Aplikace je ukládá sama, nic se neztratí." },
  { sel: "#printBtn", title: "Tisk a PDF", text: "Otevře rukopis připravený k tisku. V okně tisku zvolte <b>Uložit jako PDF</b>, pokud chcete soubor." },
  { sel: "#msExportBtn", title: "Export rukopisu", text: "Stáhne celý váš rukopis i s obrázky jako jeden soubor. Otevře se v prohlížeči i ve Wordu. Tlačítko <b>Export transkripce</b> vlevo dole naopak ukládá transkripci zdrojové knihy." },
  { sel: "#colAsk", title: "Dotaz", text: "Zeptejte se na cokoli z knih a rukopisu. Odpověď má u každého tvrzení číslo zdroje. Na číslo klikněte a otevře se místo v knize. <b>Nový dotaz</b> vše smaže." },
  { sel: "#colImg", title: "Obrázky", text: "Všechny obrázky z knih, z rukopisu i z knihovny. Klikněte na obrázek pro zvětšení, úpravu popisku a zdroje nebo vložení do rukopisu." },
  { sel: "#settingsBtn", title: "Nastavení", text: "Tady se nastavuje jazykový model pro Dotaz: model na serveru, vlastní klíč OpenAI či Anthropic, nebo model v počítači (LM Studio, Ollama)." },
  { sel: "#helpBtn", title: "Nápověda a podpora", text: "Sem se kdykoli vrátíte. Najdete tu tohoto průvodce, režim vysvětlivek, návody „Jak na to“ a formulář pro nahlášení chyby nebo nápadu." },
];

const TOPICS = [
  ["Jak přenést odstavec z knihy do rukopisu", "Zapněte sloupce <b>Transkripce</b> a <b>Rukopis</b> (tlačítko <b>Píšu s citacemi</b>). V rukopisu klikněte tam, kam má text přijít. Pak pod odstavcem v transkripci klikněte na <b>Do rukopisu</b>. Když se to nepovede, tlačítko <b>Vrátit</b> v dolní liště krok vrátí."],
  ["Jak vložit citaci se zdrojem", "Pod odstavcem v transkripci klikněte na <b>Jako citace</b>. Do rukopisu se vloží odsazená citace a pod ní název knihy se stránkou."],
  ["Jak vyříznout obrázek ze skenu", "Zapněte <b>Originál</b> a <b>Rukopis</b> (tlačítko <b>Obrázky do rukopisu</b>). Na skenu obrázek ohraničte nebo upravte rámeček. Pak klikněte na <b>Do rukopisu</b>. V okně můžete obrázek ještě oříznout, narovnat a doplnit popisek."],
  ["Jak vložit obrázek z počítače", "V rukopisu klikněte na tlačítko <b>Obrázek</b>, nebo obrázek zkopírujte (Cmd+C) a v rukopisu vložte (Cmd+V)."],
  ["Jak udělat nadpis kapitoly", "Klikněte do řádku v rukopisu a v nabídce vlevo nahoře (kde je <b>Běžný text</b>) zvolte <b>Kapitola</b>. Kapitoly se samy objeví v obsahu."],
  ["Jak vložit obsah knihy", "Klikněte v rukopisu tam, kde má obsah být (obvykle za titulní stranu), a v nástrojích zvolte <b>Vložit → Obsah knihy</b>. Obsah se sám doplňuje podle kapitol a podkapitol, nic se v něm nepřepisuje ručně. Stejně tak vložíte <b>Novou stránku</b>, aby další kapitola v tisku a v PDF začala na nové straně."],
  ["Jak najít slovo ve všech knihách", "Napište ho do pole <b>Hledat všude…</b> nahoře. Výsledky z rukopisu jsou první, pak z knih."],
  ["Jak vrátit starší verzi rukopisu", "Klikněte na <b>Historie</b>, vyberte čas a stiskněte <b>Obnovit</b>. Současná verze se předtím sama uloží, takže se nic neztratí."],
  ["Jak vytisknout nebo uložit PDF", "V rukopisu klikněte na <b>Tisk</b>. Otevře se tisková podoba. V okně tisku zvolte tiskárnu, nebo <b>Uložit jako PDF</b>."],
  ["Jak se zeptat na něco z knih", "Zapněte sloupec <b>Dotaz</b>, napište otázku a stiskněte <b>Zeptat se</b>. Odpověď trvá obvykle do minuty. Čísla v odpovědi jsou odkazy na zdroje."],
  ["Když je písmo malé", "Tlačítkem <b>A+</b> vpravo nahoře zvětšíte celou aplikaci. V rukopisu je ještě vlastní <b>A+</b> jen pro text."],
];

let step = 0;
let pointMode = false;

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest("[hidden]");
}

function place(el, title, html, stepLabel) {
  const layer = $("#tourLayer"), spot = $("#tourSpot"), bub = $("#tourBubble");
  layer.hidden = false;
  $("#tourTitle").textContent = title;
  $("#tourText").innerHTML = html;
  $("#tourStep").textContent = stepLabel || "";
  if (el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 3, width: 0, height: 0 };
  const pad = 6;
  Object.assign(spot.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + 2 * pad + "px", height: r.height + 2 * pad + "px" });
  spot.hidden = !el;
  // bubble below the element, or above / beside if there is no room
  const bw = Math.min(420, innerWidth - 24);
  bub.style.width = bw + "px";
  const bh = bub.offsetHeight || 220;
  let top = r.top + r.height + 14;
  if (top + bh > innerHeight - 10) top = r.top - bh - 14;
  if (top < 10) top = Math.min(innerHeight - bh - 10, Math.max(10, r.top + 20));
  let left = r.left + r.width / 2 - bw / 2;
  left = Math.max(12, Math.min(innerWidth - bw - 12, left));
  bub.style.top = top + "px";
  bub.style.left = left + "px";
}

function steps() { return STEPS.filter((s) => visible(document.querySelector(s.sel))); }

function show(i) {
  const list = steps();
  if (!list.length) return close();
  step = Math.max(0, Math.min(i, list.length - 1));
  const s = list[step];
  $("#tourPrev").hidden = step === 0;
  $("#tourNext").hidden = false;
  $("#tourNext").textContent = step === list.length - 1 ? "Hotovo" : "Další →";
  place(document.querySelector(s.sel), s.title, s.text, `Krok ${step + 1} z ${list.length}`);
}

function startTour() {
  $("#helpDlg").hidden = true;
  pointMode = false;
  document.body.classList.remove("help-point");
  show(0);
}

function close() {
  $("#tourLayer").hidden = true;
  pointMode = false;
  document.body.classList.remove("help-point");
}

function next() {
  if (pointMode) return close();
  if (step >= steps().length - 1) return close();
  show(step + 1);
}

// explain-what-I-click mode
function explain(el) {
  const known = STEPS.find((s) => el.closest(s.sel) && document.querySelector(s.sel) === el.closest(s.sel));
  const control = el.closest("button, select, input, textarea, [title]");
  let title = "", text = "";
  if (control && control.title) {
    title = (control.textContent || "").trim().slice(0, 40) || "Ovládací prvek";
    text = control.title;
  }
  if (known && (!text || control === document.querySelector(known.sel))) { title = known.title; text = known.text; }
  if (!text) return;
  $("#tourPrev").hidden = true;
  $("#tourNext").hidden = true;
  place(control || el, title, text + "<p class='tour-tip'>Klikněte na další prvek, nebo stiskněte <b>Konec</b>.</p>", "Režim vysvětlivek");
}

function startPoint() {
  $("#helpDlg").hidden = true;
  pointMode = true;
  document.body.classList.add("help-point");
  $("#tourPrev").hidden = true;
  $("#tourNext").hidden = true;
  place(null, "Režim vysvětlivek", "Klikněte na kterékoli tlačítko nebo část aplikace a zobrazí se, k čemu slouží. Nic se tím nespustí.", "");
}

document.addEventListener("click", (e) => {
  if (!pointMode) return;
  if (e.target.closest("#tourBubble")) return;
  e.preventDefault();
  e.stopPropagation();
  explain(e.target);
}, true);

function openHelp() {
  const box = $("#helpTopics");
  if (!box.childElementCount) {
    for (const [q, a] of TOPICS) {
      const d = document.createElement("details");
      d.innerHTML = `<summary>${q}</summary><p>${a}</p>`;
      box.append(d);
    }
  }
  $("#helpDlg").hidden = false;
}

// support form
let supShot = "";
function setShot(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1600 / img.width);
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    supShot = c.toDataURL("image/png");
    $("#supPreview").src = supShot; $("#supPreview").hidden = false;
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}
function openSupport() {
  $("#helpDlg").hidden = true;
  $("#supResult").textContent = "";
  $("#supDlg").hidden = false;
  $("#supTitle").focus();
}
$("#helpSupport").addEventListener("click", openSupport);
$("#supCancel").addEventListener("click", () => { $("#supDlg").hidden = true; });
$("#supShot").addEventListener("change", (e) => setShot(e.target.files[0]));
$("#supDlg").addEventListener("paste", (e) => {
  const item = [...(e.clipboardData || {}).items || []].find((i) => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); setShot(item.getAsFile()); }
});
$("#supSend").addEventListener("click", async () => {
  const r = $("#supResult");
  const body = {
    kind: $("#supKind").value, title: $("#supTitle").value.trim(), text: $("#supText").value.trim(), screenshot: supShot,
    context: {
      sloupce: [...document.querySelectorAll(".col-btn.active")].map((b) => b.dataset.col).join(","),
      kniha: ($("#bookSelect") || {}).value || "",
      prohlizec: navigator.userAgent, okno: innerWidth + "x" + innerHeight,
    },
  };
  if (!body.title || !body.text) { r.textContent = "Vyplňte prosím nadpis i popis."; r.classList.add("error"); return; }
  $("#supSend").disabled = true;
  r.classList.remove("error"); r.textContent = "Odesílám…";
  try {
    const res = await fetch("api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    if (!res.ok) throw new Error(res.error || "neznámá chyba");
    r.textContent = "Děkujeme, hlášení je odeslané." + (res.issue ? ` (č. ${res.issue})` : "");
    $("#supTitle").value = ""; $("#supText").value = ""; $("#supShot").value = ""; supShot = ""; $("#supPreview").hidden = true;
  } catch (e) {
    r.textContent = "Nepodařilo se odeslat: " + e.message; r.classList.add("error");
  } finally {
    $("#supSend").disabled = false;
  }
});

$("#helpBtn").addEventListener("click", () => { close(); openHelp(); });
$("#helpClose").addEventListener("click", () => { $("#helpDlg").hidden = true; });
$("#helpTour").addEventListener("click", startTour);
$("#helpPoint").addEventListener("click", startPoint);
$("#tourNext").addEventListener("click", next);
$("#tourPrev").addEventListener("click", () => show(step - 1));
$("#tourClose").addEventListener("click", close);
document.addEventListener("keydown", (e) => {
  if ($("#tourLayer").hidden) return;
  if (e.key === "Escape") close();
  else if (!pointMode && e.key === "ArrowRight") next();
  else if (!pointMode && e.key === "ArrowLeft") show(step - 1);
});
addEventListener("resize", () => { if (!$("#tourLayer").hidden && !pointMode) show(step); });

// first visit: offer the tour once
try {
  if (!localStorage.getItem("helpSeen")) {
    localStorage.setItem("helpSeen", "1");
    setTimeout(() => { if (window.showToast) window.showToast("Nová nápověda: klikněte na otazník vpravo nahoře.", 8000); }, 2500);
  }
} catch (e) { /* storage unavailable */ }
})();
