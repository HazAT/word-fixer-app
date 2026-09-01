local word_fixer = {}

local function notify_failure(message)
  -- Messages passed here are product-owned constants, never selected text.
  hl.exec_cmd("notify-send --urgency=critical 'Word Fixer' '" .. message .. "'")
end

local function active_window_is_terminal(window)
  for _, tag in ipairs(window.tags or {}) do
    if tag:gsub("%*$", "") == "terminal" then
      return true
    end
  end
  return false
end

function word_fixer.capture()
  local window = hl.get_active_window()
  if not window or type(window.address) ~= "string" or not window.address:match("^0x[%da-fA-F]+$")
      or type(window.pid) ~= "number" or window.pid < 1 or window.pid % 1 ~= 0 then
    notify_failure("No focused source window is available.")
    return
  end

  -- Capture both values before clipboard mutation or opening the overlay.
  local source_address = window.address:lower()
  local source_pid = window.pid
  local source_terminal = active_window_is_terminal(window)
  -- Return from the triggering key callback before the external client clears
  -- the clipboard or injects copy. Injecting Ctrl+C here can recursively fire
  -- SUPER+SHIFT+C while the physical trigger modifiers are still held.
  hl.timer(function()
    -- Only validated address syntax and a boolean enter this compositor-owned
    -- command. Selected text is read from wl-paste by the client, never argv.
    hl.exec_cmd("word-fixer --source-address " .. source_address
      .. " --source-pid " .. tostring(source_pid)
      .. " --source-terminal " .. tostring(source_terminal))
  end, { timeout = 150, type = "oneshot" })
end

return word_fixer
