// The spaces as a row across the top of the window, for layouts without a sidebar: each space a
// pill with its avatar (the colors the spaces list keeps in shared "space.colors"), a dot when
// something in it needs you or is done. Click to switch, right-click for its menu, + for a new
// one. Then search, settings and, where the system draws none, the window buttons.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, run, openOverlay, theme, shared, updates, window } from "herdr";

// The same avatar colors as Herdr's spaces list.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A press on a control is its own, not the window's (the bar drags the window).
const stop = (_e, cx) => cx.stop_propagation();

export default class ZooSpaces extends View {
  render() {
    const t = theme();
    const colors = shared("space.colors") ?? {};
    const button = (id, label, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_mouse_down("right", stop).on_click(action).child(label);
    const pill = (s) => {
      const color = colors[s.id] ?? "ansi6";
      const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
      return h_flex().id(`space-${s.id}`).h(29).pl(6).pr(10).gap(7).flex_none().items_center().rounded(7).text_size(12.8)
        .border(1).border_color(s.active ? t.border : t.chrome).bg(s.active ? t.raised : t.chrome)
        .text_color(s.active ? t.foreground : t.muted).cursor_pointer().hover((el) => el.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => run("space.select", { id: s.id }))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } });
        })
        .child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center()
          .text_size(10.5).font_bold().text_color("#ffffff").child([...s.name][0]?.toUpperCase() ?? "?"))
        .child(div().max_w(160).truncate().child(s.name))
        .when(s.status === "blocked" || s.status === "done", (el) => el.child(div().size(6).flex_none().rounded(3).bg(t[s.status])));
    };
    return h_flex().size_full().min_w(0).pl(12).pr(10).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(image("frame/welcome/herdr.png").size(18).rounded(5).flex_none().mr(8))
      .child(h_flex().id("space-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar()
        .children(spaces().map(pill))
        .child(button("space-new", "+", "New space", () => run("space.new"))))
      .child(button("search", svg("mods/workspace-chrome/search.svg").size(15), "Go to a tab", () => run("mod.open", { name: "picker" })))
      .child(button("settings", svg("mods/workspace-chrome/settings.svg").size(15), "Settings", () => run("app.settings"))
        .relative().when(Boolean(updates().app.ready), (el) => el.child(div().absolute().top(4).right(4).size(6).rounded_full().bg(t.accent))))
      .when(Boolean(window()?.buttons), (el) => el.child(div().w(1).h(16).mx(4).bg(t.border))
        .child(button("minimize", "−", "Minimize", () => run("window.minimize")))
        .child(button("maximize", "□", "Maximize", () => run("window.maximize")))
        .child(button("close-window", svg("mods/pane/close.svg").size(13), "Close", () => run("window.close"))));
  }
}
