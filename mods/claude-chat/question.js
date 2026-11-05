// Claude's AskUserQuestion as a card in the chat. What is asked (questions, options, multi-
// select) comes from the transcript's tool call; where Claude's screen is (which question,
// the cursor, what's ticked, the review page) from the bottom of its screen (`hc read`).
//
// Answering moves Claude's cursor with up/down and presses Enter. Not the digit keys: a digit
// picks the option, but then also lands in Claude's prompt. In the list, by position: the
// options, then "Type something", then (multi-select only) "Submit". Enter on a multi-select
// option ticks it and leaves the cursor there. With several questions, ← → move between them
// and a last "Submit" page reviews the answers ("1. Submit answers  2. Cancel").
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { hc } from "herdr";

const flat = (s) => String(s ?? "").replace(/[│┃]/g, " ").replace(/\s+/g, " ").trim();
const RECOMMENDED = / \(Recommended\)$/;

// A question's text as context and the question itself: real ones lead with paragraphs of
// background (the user's hook asks for an "ELI5: …" one), and the question is the last paragraph.
function parts(text) {
  const paras = String(text ?? "").trim().split(/\n\s*\n/);
  return { context: paras.slice(0, -1).join("\n\n"), question: paras[paras.length - 1] };
}

// An AskUserQuestion a PreToolUse hook sent back before it was shown; Claude asks again.
export const rejected = (item) => Boolean(item.error) && /^(Error: )?PreToolUse:\S+ hook error/.test(item.result ?? "");

// The AskUserQuestion still waiting for its answer, if any.
export function pending(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "tool" && item.name === "AskUserQuestion") return item.result === undefined ? item : null;
  }
  return null;
}

// Where Claude's question screen is: `at` = the shown question (questions.length = the review
// page), `cursor` = the list position the cursor is on, `ticked` = positions ticked, `done` =
// headers answered. Null when the screen isn't this question's.
export function where(screen, questions) {
  if (!screen) return null;
  const lines = screen.split("\n");
  const text = flat(screen);
  let at = /Review your answers/.test(screen) ? questions.length
    : questions.findIndex((q) => text.includes(flat(q.question).slice(0, 60)));
  if (at < 0) return null;
  const n = questions[at]?.options?.length ?? 0;
  let cursor = 1;
  const ticked = new Set();
  for (const line of lines) {
    const m = /^\s*❯\s*(\d+)\./.exec(line);
    if (m) cursor = Number(m[1]);
    else if (/^\s*❯\s*Submit\b/.test(line)) cursor = n + 2;
    const box = /^\s*(?:❯\s*)?(\d+)\.\s*\[(.)\]/.exec(line);
    if (box && box[2] !== " ") ticked.add(Number(box[1]));
  }
  const done = new Set(questions.filter((q) => q.header && screen.includes(`☒ ${q.header}`)).map((q) => q.header));
  // The review page's answers: "● question" then "→ answer".
  const review = [];
  if (at === questions.length) for (const line of lines) {
    if (/^\s*●/.test(line)) review.push({ q: flat(line.replace(/^\s*●/, "")), a: "" });
    else if (/^\s*→/.test(line) && review.length) review[review.length - 1].a = flat(line.replace(/^\s*→/, ""));
  }
  return { at, cursor, ticked, done, review };
}

// Up/down from the cursor to `to`, then Enter (unless `enter` is false).
function moves(cursor, to, enter = true) {
  const d = to - cursor;
  return [...Array(Math.abs(d)).fill(d > 0 ? "down" : "up"), ...(enter ? ["enter"] : [])];
}

// Press keys in Claude's terminal; the card waits (dimmed) for the screen read after it, so a
// second click doesn't go by a cursor that has moved.
function press(view, keys) {
  return (_e, cx) => {
    if (!view.screen || !keys.length) return;
    const address = view.address;
    view.screen = null;
    cx.notify();
    cx.spawn(async () => { await hc(["keys", address, ...keys]); });
    cx.timer.after(400, (cx) => view.tick(cx));
  };
}

// What's typed in the chat's box while a question shows: the "Type something" answer.
// False when no question card is up (then the box sends as usual).
export function typeAnswer(view, text, cx) {
  const item = pending(view.items);
  const questions = item?.input?.questions ?? [];
  const w = where(view.screen, questions);
  if (!w || w.at >= questions.length) return false;
  const address = view.address;
  const keys = moves(w.cursor, questions[w.at].options.length + 1, false);
  view.screen = null;
  cx.spawn(async () => {
    if (keys.length) await hc(["keys", address, ...keys]);
    // Claude is blocked, so hc refuses to type unless forced.
    await hc(["send", "--force", address, text]);
  });
  return true;
}

// The card under the chat while Claude asks. Null when the screen doesn't match the question
// (the chat then shows the plain screen panel).
export function card(view, t, px) {
  const item = pending(view.items);
  const questions = item?.input?.questions ?? [];
  if (!questions.length) return null;
  const w = where(view.screen, questions);
  // Between a click and the next screen read: the card stays, dimmed, as it was.
  const shown = w ?? (view.screen === null ? view.lastAsk : null);
  if (!shown) return null;
  if (w) view.lastAsk = w;
  const wait = !w;
  const many = questions.length > 1;
  // Folded: the header and the question on one line, so the chat above has the room. Kept per
  // question (the tool call's id), so the next question opens unfolded.
  const folded = view.askFolded === item.id;
  const fold = (_e, cx) => { view.askFolded = folded ? null : item.id; cx.notify(); };
  const title = many ? "Claude has questions" : "Claude is asking";
  const current = questions[Math.min(shown.at, questions.length - 1)];

  const head = h_flex().gap(8).items_center()
    .child(div().size(8).flex_none().rounded(4).bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1200 }))
    .child(h_flex().id("ask-fold").flex_1().min_w(0).gap(6).items_center().cursor_pointer()
      .tooltip(folded ? "Show the question" : "Fold the question")
      .on_click(fold)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(title))
      .when(folded, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted)
        .child(flat(parts(current?.question).question))))
      .when(!folded, (el) => el.child(div().flex_1()))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim)))
    .when(many && !folded, (el) => el.child(h_flex().flex_none().gap(4)
      .children([...questions.map((q, i) => [q.header || `Q${i + 1}`, i]), ["Submit", questions.length]].map(([label, i]) =>
        div().id(`ask-tab-${i}`).px(8).py(2).rounded(6).text_size(px(11)).cursor_pointer()
          .when(i === shown.at, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(i !== shown.at, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
          .on_click(press(view, Array(Math.abs(i - shown.at)).fill(i > shown.at ? "right" : "left")))
          .child(shown.done.has(label) ? `✓ ${label}` : label)))));

  const foot = (hint) => h_flex().gap(8).items_center()
    .child(div().flex_1().min_w(0).text_size(px(11.5)).text_color(t.dim).child(hint))
    .child(view.button(t, "ask-esc", "Dismiss", press(view, ["esc"])))
    .child(view.button(t, "ask-terminal", "Open terminal", () => view.toTerminal(view.address)));

  const box = v_flex().gap(10).p(12).rounded(10).bg(t.surface).border(1).border_color(t.blocked)
    .when(wait, (el) => el.opacity(0.6))
    .child(head);

  if (folded) return box.p(8).gap(0);

  if (shown.at === questions.length) {
    return box
      .child(div().text_size(px(14)).font_semibold().text_color(t.foreground).child("Send these answers?"))
      .child(v_flex().gap(6).children(shown.review.map((r, i) => v_flex().id(`ask-review-${i}`).gap(2)
        .child(div().text_size(px(12)).text_color(t.muted).child(r.q))
        .child(div().text_color(t.foreground).font_medium().child(`→ ${r.a || "(no answer)"}`)))))
      .child(h_flex().gap(6)
        .child(view.button(t, "ask-submit", "Submit answers", press(view, moves(shown.cursor, 1)), true))
        .child(view.button(t, "ask-back", "Back", press(view, ["left"]))))
      .child(foot(""));
  }

  const q = questions[shown.at];
  const multi = Boolean(q.multiSelect);
  const options = (q.options ?? []).map((o, i) => {
    const pos = i + 1;
    const best = RECOMMENDED.test(o.label);
    const on = shown.ticked.has(pos);
    return h_flex().id(`ask-opt-${shown.at}-${i}`).w_full().gap(10).items_start().px(10).py(8).rounded(8)
      .bg(t.background).border(1).border_color(on ? t.accent : t.border).cursor_pointer()
      .hover((s) => s.border_color(t.accent))
      .on_click(press(view, moves(shown.cursor, pos)))
      .when(multi, (el) => el.child(div().mt(2).size(14).flex_none().rounded(3).border(1)
        .border_color(on ? t.accent : t.dim).bg(on ? t.accent : t.background)
        .flex().items_center().justify_center().text_size(10).text_color(t.solid_foreground).child(on ? "✓" : "")))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().font_semibold().text_color(t.foreground).child(o.label.replace(RECOMMENDED, "")))
          .when(best, (el) => el.child(div().flex_none().px(6).rounded(4).text_size(px(10.5))
            .bg(t.accent).text_color(t.solid_foreground).child("Recommended"))))
        .when(Boolean(o.description), (el) => el.child(div().text_size(px(12)).text_color(t.muted)
          .child(TextView.markdown(`ask-desc-${shown.at}-${i}`, o.description)))));
  });

  // Markdown, as Claude writes it: the context regular, the question itself bold.
  const { context, question } = parts(q.question);
  return box
    .when(Boolean(context), (el) => el.child(div().text_color(t.muted)
      .child(TextView.markdown(`ask-context-${shown.at}`, context).selectable(true))))
    .child(div().text_size(px(14)).font_semibold().text_color(t.foreground)
      .child(TextView.markdown(`ask-question-${shown.at}`, question).selectable(true)))
    .when(multi, (el) => el.child(div().text_size(px(11.5)).text_color(t.dim).child("Pick any, then Next.")))
    .child(v_flex().gap(6).children(options))
    .when(multi, (el) => el.child(h_flex().child(view.button(t, "ask-next", many ? "Next" : "Submit",
      press(view, moves(shown.cursor, q.options.length + 2)), true))))
    .child(foot("Or type your own answer below and press Enter."));
}

// An AskUserQuestion in the log: each question with its answer, from the tool result
// ("…"="answer" pairs).
export function asked(t, px, item) {
  const questions = item.input?.questions ?? [];
  const result = item.result ?? "";
  const answer = (q) => {
    const key = `"${q.question}"="`;
    const at = result.indexOf(key);
    if (at < 0) return null;
    const m = /^([\s\S]*?)"(?=, "|\. |$)/.exec(result.slice(at + key.length));
    return (m?.[1] ?? "").replace(/<hc\b[^>]*>|<\/hc>/g, "");
  };
  // Still waiting: the card below shows it, so one line here.
  if (item.result === undefined) {
    return div().w_full().pl(16).text_size(px(12)).text_color(t.dim)
      .child(`Asking: ${questions.map((q) => q.header || q.question).join(", ")} ↓`);
  }
  return v_flex().w_full().pl(16).gap(6).children(questions.map((q, i) => {
    const a = answer(q);
    return v_flex().id(`asked-${item.id}-${i}`).gap(3).pl(10).border_l(2).border_color(item.error ? t.dim : t.accent)
      .child(h_flex().gap(6).items_center().text_size(px(12)).text_color(t.muted)
        .when(Boolean(q.header), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(px(10.5)).text_color(t.dim).child(q.header)))
        .child(div().flex_1().min_w(0).child(flat(parts(q.question).question))))
      .child(div().text_size(px(13)).text_color(a ? t.foreground : t.dim).font_medium()
        .child(a ? `→ ${a}` : item.error ? "Dismissed" : "→ (answered in the terminal)"));
  }));
}
