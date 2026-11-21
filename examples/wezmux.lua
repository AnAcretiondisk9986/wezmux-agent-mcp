local wezterm = require("wezterm")
local config = wezterm.config_builder()
local act = wezterm.action

-- Compatible with both vcabeli/wezmux (~/.wezmux.lua) and upstream WezTerm (~/.wezterm.lua)
pcall(function()
  config.sidebar = {
    visible = true,
    width = "280px",
    colors = {
      bg = "#181825",
      card_bg = "#1e1e2e",
      card_hover = "#313244",
      accent = "#cba6f7",
      text = "#cdd6f4",
      muted = "#a6adc8",
      separator = "rgba(205, 214, 244, 0.12)",
      pr_open = "#cba6f7",
      pr_merged = "#a6e3a1",
      pr_closed = "#f38ba8",
    },
  }
end)

-- Show pane_id and workspace on the right status bar for easy multi-agent addressing
wezterm.on("update-right-status", function(window, pane)
  local workspace = window:active_workspace()
  local pane_id = pane and tostring(pane:pane_id()) or "?"
  window:set_right_status(wezterm.format({
    { Foreground = { Color = "#cba6f7" } },
    { Text = " pane:" .. pane_id .. " " },
    { Foreground = { Color = "#89b4fa" } },
    { Text = "| " .. workspace .. " " },
  }))
end)

-- Windows/Linux friendly Wezmux sidebar & workspace keybindings
config.keys = {
  { key = "b", mods = "CTRL|SHIFT", action = act.ToggleSidebar },
  { key = "u", mods = "ALT", action = act.JumpToUnreadNotification },
  { key = "k", mods = "ALT", action = act.SwitchWorkspaceRelative(-1) },
  { key = "j", mods = "ALT", action = act.SwitchWorkspaceRelative(1) },
  { key = "n", mods = "CTRL|SHIFT", action = act.PromptNewWorkspace },
  { key = "g", mods = "CTRL|SHIFT", action = act.MoveWorkspaceToGroup },
}

return config
