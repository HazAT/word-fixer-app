var SCHEMA_VERSION = 1
var REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
var TOKEN_PATTERN = /\r\n|\r|\n|[^\S\r\n]+|[^\s\r\n]+/g
var LINE_BREAK_PATTERN = /\r\n|\r|\n/g
var MAX_LCS_CELLS = 65536

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value, required, optional) {
  var allowed = {}
  var i
  for (i = 0; i < required.length; i++) {
    if (!own(value, required[i])) return false
    allowed[required[i]] = true
  }
  for (i = 0; i < optional.length; i++) allowed[optional[i]] = true
  for (var key in value) {
    if (own(value, key) && !allowed[key]) return false
  }
  return true
}

function nonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0
}

function absolutePath(value) {
  return typeof value === "string" && value.charAt(0) === "/" && value.indexOf("\u0000") === -1
}

function invalid(message) {
  return { valid: false, error: message }
}

function parsePayload(payloadJson) {
  var value
  try {
    value = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson
  } catch (e) {
    return invalid("The review request was not valid JSON.")
  }

  if (!record(value)) return invalid("The review request must be an object.")
  if (value.schemaVersion !== SCHEMA_VERSION) return invalid("The review request uses an unsupported schema version.")
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId))
    return invalid("The review request has an invalid request ID.")
  if (!absolutePath(value.completionFile)) return invalid("The review request has an invalid completion path.")

  var common = ["schemaVersion", "requestId", "state", "completionFile"]
  if (value.state === "loading") {
    if (!exactKeys(value, common, [])) return invalid("The loading request contains unsupported fields.")
    return {
      valid: true,
      schemaVersion: SCHEMA_VERSION,
      requestId: value.requestId,
      completionFile: value.completionFile,
      state: "loading"
    }
  }

  if (value.state === "review") {
    var required = common.concat(["original", "correction", "natural", "takeaway"])
    if (!exactKeys(value, required, ["cost"])) return invalid("The review response has missing or unsupported fields.")
    if (typeof value.original !== "string") return invalid("The review response has invalid original text.")
    if (!nonEmptyText(value.correction) || !nonEmptyText(value.natural) || !nonEmptyText(value.takeaway))
      return invalid("The review response is missing a correction or takeaway.")
    if (own(value, "cost") && (typeof value.cost !== "number" || !isFinite(value.cost) || value.cost < 0))
      return invalid("The review response has an invalid cost.")

    var review = {
      valid: true,
      schemaVersion: SCHEMA_VERSION,
      requestId: value.requestId,
      completionFile: value.completionFile,
      state: "review",
      original: value.original,
      correction: value.correction,
      natural: value.natural,
      takeaway: value.takeaway
    }
    if (own(value, "cost")) review.cost = value.cost
    return review
  }

  if (value.state === "error") {
    if (!exactKeys(value, common.concat(["message"]), ["action"]))
      return invalid("The error response has missing or unsupported fields.")
    if (!nonEmptyText(value.message)) return invalid("The error response has no message.")
    if (own(value, "action") && !nonEmptyText(value.action)) return invalid("The error response has an invalid action.")
    return {
      valid: true,
      schemaVersion: SCHEMA_VERSION,
      requestId: value.requestId,
      completionFile: value.completionFile,
      state: "error",
      message: value.message,
      action: value.action || "Dismiss and try the shortcut again."
    }
  }

  return invalid("The review request has an unknown state.")
}

function appendSegment(segments, kind, text) {
  if (!text) return
  var previous = segments.length > 0 ? segments[segments.length - 1] : null
  if (previous && previous.kind === kind) previous.text += text
  else segments.push({ kind: kind, text: text })
}

function tokenize(text) {
  return String(text).match(TOKEN_PATTERN) || []
}

function splitLines(text) {
  var lines = []
  var start = 0
  var match
  LINE_BREAK_PATTERN.lastIndex = 0
  while ((match = LINE_BREAK_PATTERN.exec(text)) !== null) {
    lines.push({ content: text.slice(start, match.index), separator: match[0] })
    start = match.index + match[0].length
  }
  lines.push({ content: text.slice(start), separator: "" })
  return lines
}

function fallbackDiff(originalTokens, correctedTokens) {
  var prefix = 0
  while (prefix < originalTokens.length && prefix < correctedTokens.length
      && originalTokens[prefix] === correctedTokens[prefix]) prefix++

  var oldSuffix = originalTokens.length
  var newSuffix = correctedTokens.length
  while (oldSuffix > prefix && newSuffix > prefix
      && originalTokens[oldSuffix - 1] === correctedTokens[newSuffix - 1]) {
    oldSuffix--
    newSuffix--
  }

  var changes = []
  var i
  for (i = 0; i < prefix; i++) changes.push({ kind: "unchanged", text: originalTokens[i] })
  for (i = prefix; i < oldSuffix; i++) changes.push({ kind: "deleted", text: originalTokens[i] })
  for (i = prefix; i < newSuffix; i++) changes.push({ kind: "added", text: correctedTokens[i] })
  for (i = oldSuffix; i < originalTokens.length; i++) changes.push({ kind: "unchanged", text: originalTokens[i] })
  return changes
}

function tokenDiff(originalTokens, correctedTokens) {
  var oldLength = originalTokens.length
  var newLength = correctedTokens.length
  if (oldLength * newLength > MAX_LCS_CELLS) return fallbackDiff(originalTokens, correctedTokens)

  var table = new Array(oldLength + 1)
  var oldIndex
  var newIndex
  for (oldIndex = 0; oldIndex <= oldLength; oldIndex++) {
    table[oldIndex] = new Array(newLength + 1)
    for (newIndex = 0; newIndex <= newLength; newIndex++) table[oldIndex][newIndex] = 0
  }

  for (oldIndex = oldLength - 1; oldIndex >= 0; oldIndex--) {
    for (newIndex = newLength - 1; newIndex >= 0; newIndex--) {
      table[oldIndex][newIndex] = originalTokens[oldIndex] === correctedTokens[newIndex]
        ? table[oldIndex + 1][newIndex + 1] + 1
        : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1])
    }
  }

  var changes = []
  oldIndex = 0
  newIndex = 0
  while (oldIndex < oldLength && newIndex < newLength) {
    if (originalTokens[oldIndex] === correctedTokens[newIndex]) {
      changes.push({ kind: "unchanged", text: originalTokens[oldIndex] })
      oldIndex++
      newIndex++
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      changes.push({ kind: "deleted", text: originalTokens[oldIndex++] })
    } else {
      changes.push({ kind: "added", text: correctedTokens[newIndex++] })
    }
  }
  while (oldIndex < oldLength) changes.push({ kind: "deleted", text: originalTokens[oldIndex++] })
  while (newIndex < newLength) changes.push({ kind: "added", text: correctedTokens[newIndex++] })
  return changes
}

function appendTokenDiff(segments, original, corrected) {
  var changes = tokenDiff(tokenize(original), tokenize(corrected))
  for (var i = 0; i < changes.length; i++) appendSegment(segments, changes[i].kind, changes[i].text)
}

function createInlineDiff(original, corrected) {
  if (typeof original !== "string" || typeof corrected !== "string")
    throw new TypeError("Inline diff inputs must be strings.")
  if (original === corrected) return original ? [{ kind: "unchanged", text: original }] : []

  var originalLines = splitLines(original)
  var correctedLines = splitLines(corrected)
  var matchingStructure = originalLines.length === correctedLines.length
  var i
  if (matchingStructure) {
    for (i = 0; i < originalLines.length; i++) {
      if (originalLines[i].separator !== correctedLines[i].separator) {
        matchingStructure = false
        break
      }
    }
  }

  var segments = []
  if (!matchingStructure) {
    appendTokenDiff(segments, original, corrected)
    return segments
  }

  for (i = 0; i < originalLines.length; i++) {
    appendTokenDiff(segments, originalLines[i].content, correctedLines[i].content)
    appendSegment(segments, "unchanged", correctedLines[i].separator)
  }
  return segments
}

function escapeStyledText(text) {
  var source = String(text)
  var out = ""
  for (var i = 0; i < source.length; i++) {
    var c = source.charAt(i)
    if (c === "&") out += "&amp;"
    else if (c === "<") out += "&lt;"
    else if (c === ">") out += "&gt;"
    else if (c === "\"") out += "&quot;"
    else if (c === "'") out += "&#39;"
    else if (c === " ") out += "&nbsp;"
    else if (c === "\t") out += "&nbsp;&nbsp;&nbsp;&nbsp;"
    else if (c === "\r") {
      if (source.charAt(i + 1) === "\n") i++
      out += "<br/>"
    } else if (c === "\n") out += "<br/>"
    else out += c
  }
  return out
}

function safeColor(value, fallback) {
  var color = String(value || "")
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : fallback
}

function renderDiff(original, corrected, colors) {
  var palette = record(colors) ? colors : {}
  var foreground = safeColor(palette.foreground, "#cacccc")
  var added = safeColor(palette.added, "#7fbf7f")
  var deleted = safeColor(palette.deleted, "#d77878")
  var segments = createInlineDiff(original, corrected)
  var html = []

  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i]
    var escaped = escapeStyledText(segment.text)
    if (segment.kind === "deleted")
      html.push('<span style="color:' + deleted + ';text-decoration:line-through;">' + escaped + "</span>")
    else if (segment.kind === "added")
      html.push('<span style="color:' + added + ';font-weight:600;text-decoration:underline;">' + escaped + "</span>")
    else html.push('<span style="color:' + foreground + ';">' + escaped + "</span>")
  }
  return html.join("")
}

function nextChoice(index, direction) {
  var current = index === 1 ? 1 : 0
  return direction < 0 ? (current - 1 + 2) % 2 : (current + 1) % 2
}

function keyAction(key, shift, state) {
  if (key === "Escape") return { action: "cancel" }
  if (state !== "review") return { action: "none" }
  if (key === "Enter" || key === "Return") return { action: "accept" }
  if (key === "Backtab" || key === "Tab") return { action: "select", direction: (key === "Backtab" || shift) ? -1 : 1 }
  return { action: "none" }
}

function completion(requestId, outcome, choice) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId))
    throw new TypeError("Completion request ID is invalid.")
  if (outcome === "cancel") return { schemaVersion: SCHEMA_VERSION, requestId: requestId, outcome: "cancel" }
  if (outcome === "choice" && (choice === 0 || choice === 1))
    return { schemaVersion: SCHEMA_VERSION, requestId: requestId, outcome: "choice", choice: choice }
  throw new TypeError("Completion outcome is invalid.")
}

function formatCost(cost) {
  if (typeof cost !== "number" || !isFinite(cost) || cost < 0) return ""
  return "Total cost $" + cost.toFixed(cost < 0.001 ? 6 : 4)
}

if (typeof module !== "undefined") {
  module.exports = {
    parsePayload: parsePayload,
    createInlineDiff: createInlineDiff,
    escapeStyledText: escapeStyledText,
    renderDiff: renderDiff,
    nextChoice: nextChoice,
    keyAction: keyAction,
    completion: completion,
    formatCost: formatCost
  }
}
