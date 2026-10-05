local wezterm = require 'wezterm'
local config = {}
-- config.font = wezterm.font("Commented Out")
config.font = wezterm.font_with_fallback({ "Iosevka Nerd Font", 'Apple Color Emoji' })
config.font_size = 15.0
return config
