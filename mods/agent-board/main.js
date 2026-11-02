// Agents as cards on a board: Needs you, Working, Done. Click a card to show that agent.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, run, theme, setAgentOrder } from "herdr";

const COLUMNS = [
  { id: "blocked", label: "Needs you", statuses: ["blocked"] },
  { id: "working", label: "Working", statuses: ["working"] },
  { id: "done", label: "Done", statuses: ["done", "idle"] },
];

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class AgentBoard extends View {
  init(_props, cx) {
    // Only the "3m ago" labels need a clock; the board itself redraws on live data.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  card(t, a, tab, pane, now) {
    const color = t[a.status] ?? t.dim;
    const since = a.status === "working" ? tab?.working_since : tab?.changed_at;
    const tabName = tab?.named ? tab.name : a.title || a.program?.name || "";
    const pic = icon(a.program, 18, t.foreground);
    return v_flex()
      .id(`card-${a.address}`)
      .flex_none()
      .p(10)
      .gap(6)
      .rounded(8)
      .bg(a.focused ? t.selected : t.surface)
      .border(1)
      .border_color(a.status === "blocked" ? color : a.focused ? t.accent : t.border)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(h_flex().gap(8).items_center()
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(a.space_name || a.program?.name || a.address))
        .child(this.badge(t, a.status)))
      .child(div().truncate().text_size(12).text_color(t.muted).child(tabName))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .when(Boolean(pane?.branch), (el) => el
          .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(pane.branch)))
        .when(!pane?.branch, (el) => el.child(div().flex_1()))
        .when(Boolean(since), (el) => el.child(div().flex_none().child(ago(now - since))))
        .child(div().flex_none().child(a.address)));
  }

  badge(t, status) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return div().size(8).flex_none().rounded(4).bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1200 });
    if (status === "done") return div().size(8).flex_none().rounded(4).bg(t.done);
    return div().size(8).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  }

  column(t, col, cards) {
    const color = t[col.id] ?? t.dim;
    return v_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .rounded(10)
      .bg(t.chrome)
      .border(1)
      .border_color(t.border)
      .child(h_flex().px(12).h(40).flex_none().gap(8).items_center()
        .child(div().size(8).rounded(4).bg(color))
        .child(div().font_semibold().text_color(t.foreground).child(col.label))
        .child(div().text_color(t.dim).child(String(cards.length))))
      .child(v_flex().id(`col-${col.id}`).flex_1().min_h(0).px(8).pb(8).gap(8).overflow_y_scrollbar()
        .when(cards.length === 0, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child("Nothing here")))
        .children(cards));
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const byPane = new Map(panes().map((p) => [p.pane, p]));
    // Most recently changed first within each column.
    const list = [...agents()].sort((x, y) => y.seq - x.seq);
    const grouped = COLUMNS.map((col) => list.filter((a) => col.statuses.includes(a.status)));
    setAgentOrder(grouped.flat().map((a) => a.address));

    return h_flex()
      .size_full()
      .min_h(0)
      .p(8)
      .gap(8)
      .bg(t.canvas)
      .text_size(13)
      .children(COLUMNS.map((col, i) =>
        this.column(t, col, grouped[i].map((a) => this.card(t, a, tabs.get(a.tab), byPane.get(a.pane), now)))));
  }
}
