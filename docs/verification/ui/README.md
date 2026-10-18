# Release UI verification

Acceptance requires paired **real release application** and **VS Code 1.142.0** screenshots. None have passed yet.

Record OS, display/DPI, window client and outer sizes, 100% zoom, font, VS Code commit, LiteCode build ID and WebView2 version in `environment.json`. Use the same fixture directory, Git state, query, cursor and focus. Keep original captures; never rescale to hide differences.

Required scenes: empty shell; tree selection/rename/context menu; editor/group/dirty/breadcrumb; find/replace; Search View/filters/preview; Quick Open/Access; Quick Search/Search Editor; completion/hover/diagnostics/peek; errors/conflict/recovery. Repeat affected scenes after shared style changes, then verify keyboard, focus, IME and mouse behavior.

`issues.md` must record scene, difference, cause, fix and recapture outcome. Browser-only screenshots, if present, are development evidence and cannot close Q05.
