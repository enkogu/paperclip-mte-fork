const NONTERMINAL_STATUSES = new Set(["queued", "running", "scheduled_retry"]);

function canStartRegex(previous) {
  if (!previous) return true;
  if (
    previous.kind === "identifier" &&
    ["await", "case", "delete", "do", "else", "in", "instanceof", "of", "return", "throw", "typeof", "void", "yield"].includes(previous.value)
  ) return true;
  return previous.kind === "punct" && ![")", "]", "}", "."].includes(previous.value);
}

function tokenize(source) {
  const tokens = [];
  function scan(startIndex, stopAtInterpolationEnd = false) {
    let index = startIndex;
    let braceDepth = 0;
    for (; index < source.length;) {
      const start = index;
      const char = source[index];
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (char === "/" && source[index + 1] === "/") {
        index = source.indexOf("\n", index + 2);
        if (index < 0) break;
        continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        index = source.indexOf("*/", index + 2);
        if (index < 0) {
          tokens.push({ kind: "unknown", value: "unterminated-comment", start });
          break;
        }
        index += 2;
        continue;
      }
      if (char === "/" && canStartRegex(tokens.at(-1))) {
        index += 1;
        let escaped = false;
        let inCharacterClass = false;
        let closed = false;
        while (index < source.length) {
          const next = source[index++];
          if (escaped) {
            escaped = false;
          } else if (next === "\\") {
            escaped = true;
          } else if (next === "[") {
            inCharacterClass = true;
          } else if (next === "]") {
            inCharacterClass = false;
          } else if (next === "/" && !inCharacterClass) {
            closed = true;
            break;
          } else if (next === "\n" || next === "\r") {
            break;
          }
        }
        while (closed && index < source.length && /[A-Za-z]/.test(source[index])) index += 1;
        tokens.push({ kind: closed ? "regex" : "unknown", value: "regex", start });
        continue;
      }
      if (char === '"' || char === "'") {
        const quote = char;
        index += 1;
        let value = "";
        let closed = false;
        while (index < source.length) {
          const next = source[index++];
          if (next === "\\") {
            if (index < source.length) value += source[index++];
          } else if (next === quote) {
            closed = true;
            break;
          } else {
            value += next;
          }
        }
        tokens.push({ kind: closed ? "string" : "unknown", value, start });
        continue;
      }
      if (char === "`") {
        index += 1;
        let escaped = false;
        while (index < source.length) {
          const next = source[index++];
          if (escaped) escaped = false;
          else if (next === "\\") escaped = true;
          else if (next === "`") break;
          else if (next === "$" && source[index] === "{") {
            index = scan(index + 1, true);
          }
        }
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        index += 1;
        while (index < source.length && /[\w$]/.test(source[index])) index += 1;
        tokens.push({ kind: "identifier", value: source.slice(start, index), start });
        continue;
      }
      if (source.startsWith("...", index)) {
        tokens.push({ kind: "punct", value: "...", start });
        index += 3;
        continue;
      }
      if (char === "{") braceDepth += 1;
      if (char === "}") {
        if (stopAtInterpolationEnd && braceDepth === 0) return index + 1;
        braceDepth -= 1;
      }
      tokens.push({ kind: "punct", value: char, start });
      index += 1;
    }
    return index;
  }
  scan(0);
  return tokens;
}

function closeIndex(tokens, openIndex) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const expected = pairs[tokens[openIndex]?.value];
  if (!expected) return -1;
  const stack = [expected];
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (pairs[value]) stack.push(pairs[value]);
    else if (value === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function openIndex(tokens, closeAt) {
  const pairs = { ")": "(", "}": "{", "]": "[" };
  const expected = pairs[tokens[closeAt]?.value];
  if (!expected) return -1;
  const stack = [expected];
  for (let index = closeAt - 1; index >= 0; index -= 1) {
    const value = tokens[index].value;
    if (pairs[value]) stack.push(pairs[value]);
    else if (value === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function expressionEnd(tokens, start, limit) {
  const stack = [];
  const pairs = { "(": ")", "{": "}", "[": "]" };
  for (let index = start; index < limit; index += 1) {
    const value = tokens[index].value;
    if (pairs[value]) stack.push(pairs[value]);
    else if (value === stack.at(-1)) stack.pop();
    else if (stack.length === 0 && (value === "," || value === ";")) return index;
  }
  return limit;
}

function unwrap(tokens) {
  let value = tokens;
  while (value[0]?.value === "(" && closeIndex(value, 0) === value.length - 1) {
    value = value.slice(1, -1);
  }
  return value;
}

function analyzeStatusValue(tokens, bindings, seen) {
  const value = unwrap(tokens);
  if (value[0]?.kind === "string") {
    return NONTERMINAL_STATUSES.has(value[0].value) ? null : `status ${JSON.stringify(value[0].value)} is terminal-capable`;
  }
  if (value.length >= 1 && value[0].kind === "identifier") {
    const binding = bindings.get(value[0].value);
    if (binding && !seen.has(value[0].value)) {
      const nextSeen = new Set(seen).add(value[0].value);
      return analyzeStatusValue(binding, bindings, nextSeen);
    }
  }
  return "status value is not provably nonterminal";
}

function analyzeSetValue(tokens, bindings, seen = new Set()) {
  const value = unwrap(tokens);
  if (value.length === 1 && value[0].kind === "identifier") {
    const name = value[0].value;
    const binding = bindings.get(name);
    if (!binding || seen.has(name)) return "set object is not statically known";
    return analyzeSetValue(binding, bindings, new Set(seen).add(name));
  }
  if (value[0]?.value !== "{") return "set argument is not a statically known object literal";
  const objectClose = closeIndex(value, 0);
  if (objectClose < 0) return "set object literal is unbalanced";

  for (let index = 1; index < objectClose;) {
    if (value[index].value === ",") {
      index += 1;
      continue;
    }
    if (value[index].value === "...") {
      const end = expressionEnd(value, index + 1, objectClose);
      const spreadFinding = analyzeSetValue(value.slice(index + 1, end), bindings, seen);
      if (spreadFinding) return `spread is unsafe: ${spreadFinding}`;
      index = end;
      continue;
    }
    const key = value[index];
    if (key.kind !== "identifier" && key.kind !== "string") return "computed or unknown set property";
    const propertyName = key.value;
    if (value[index + 1]?.value === ":") {
      const end = expressionEnd(value, index + 2, objectClose);
      if (propertyName === "status") {
        const finding = analyzeStatusValue(value.slice(index + 2, end), bindings, seen);
        if (finding) return finding;
      }
      index = end;
      continue;
    }
    if (propertyName === "status") {
      const finding = analyzeStatusValue([key], bindings, seen);
      if (finding) return finding;
    }
    index += 1;
  }
  return null;
}

export function auditHeartbeatRunUpdates(source) {
  const tokens = tokenize(source);
  const bindingScopes = [new Map()];
  const heartbeatAliasScopes = [new Map([["heartbeatRuns", true]])];
  const databaseAliasScopes = [new Map(["db", "tx", "trx", "database"].map((name) => [name, true]))];
  const updateAliasScopes = [new Map()];
  const findings = [];

  const resolveScoped = (scopes, name) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (scopes[index].has(name)) return scopes[index].get(name);
    }
    return undefined;
  };
  const visibleBindings = () => {
    const result = new Map();
    for (const scope of bindingScopes) {
      for (const [name, value] of scope) result.set(name, value);
    }
    return result;
  };
  const isHeartbeatAlias = (name) => resolveScoped(heartbeatAliasScopes, name) === true;
  const isDatabaseAlias = (name) => resolveScoped(databaseAliasScopes, name) === true;
  const shadowDatabaseName = (token) => {
    if (token?.kind === "identifier" && ["db", "tx", "trx", "database"].includes(token.value)) {
      databaseAliasScopes.at(-1).set(token.value, false);
    }
  };
  const splitTopLevel = (value, delimiter) => {
    const parts = [];
    let start = 0;
    const stack = [];
    const pairs = { "(": ")", "{": "}", "[": "]" };
    for (let index = 0; index < value.length; index += 1) {
      const token = value[index]?.value;
      if (pairs[token]) stack.push(pairs[token]);
      else if (token === stack.at(-1)) stack.pop();
      else if (token === delimiter && stack.length === 0) {
        parts.push(value.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(value.slice(start));
    return parts;
  };
  const topLevelIndex = (value, delimiter) => {
    const stack = [];
    const pairs = { "(": ")", "{": "}", "[": "]" };
    for (let index = 0; index < value.length; index += 1) {
      const token = value[index]?.value;
      if (pairs[token]) stack.push(pairs[token]);
      else if (token === stack.at(-1)) stack.pop();
      else if (token === delimiter && stack.length === 0) return index;
    }
    return -1;
  };
  const shadowBindingPattern = (pattern) => {
    let value = unwrap(pattern);
    if (value[0]?.value === "...") value = value.slice(1);
    if (value[0]?.kind === "identifier") {
      shadowDatabaseName(value[0]);
      return;
    }
    if (!["{", "["].includes(value[0]?.value)) return;
    const close = closeIndex(value, 0);
    if (close < 0) return;
    for (let part of splitTopLevel(value.slice(1, close), ",")) {
      if (part.length === 0) continue;
      if (part[0]?.value === "...") part = part.slice(1);
      if (value[0].value === "{") {
        const colon = topLevelIndex(part, ":");
        if (colon >= 0) part = part.slice(colon + 1);
      }
      const defaultValue = topLevelIndex(part, "=");
      if (defaultValue >= 0) part = part.slice(0, defaultValue);
      shadowBindingPattern(part);
    }
  };

  const shadowParametersForBlock = (blockOpen) => {
    let parametersOpen = -1;
    let parametersClose = -1;
    if (tokens[blockOpen - 1]?.value === ">" && tokens[blockOpen - 2]?.value === "=") {
      if (tokens[blockOpen - 3]?.value === ")") {
        parametersClose = blockOpen - 3;
        parametersOpen = openIndex(tokens, parametersClose);
      } else if (tokens[blockOpen - 3]?.kind === "identifier") {
        parametersOpen = blockOpen - 3;
        parametersClose = blockOpen - 3;
      }
    } else if (tokens[blockOpen - 1]?.value === ")") {
      const candidateClose = blockOpen - 1;
      const candidateOpen = openIndex(tokens, candidateClose);
      const beforeParameters = tokens[candidateOpen - 1]?.value;
      const functionDeclaration = beforeParameters === "function" || tokens[candidateOpen - 2]?.value === "function";
      const catchClause = beforeParameters === "catch";
      const methodDeclaration =
        tokens[candidateOpen - 1]?.kind === "identifier" &&
        !["if", "for", "while", "switch", "with"].includes(beforeParameters);
      if (candidateOpen >= 0 && (functionDeclaration || catchClause || methodDeclaration)) {
        parametersOpen = candidateOpen;
        parametersClose = candidateClose;
      }
    }
    if (parametersOpen < 0) return;
    if (parametersOpen === parametersClose) {
      shadowBindingPattern(tokens.slice(parametersOpen, parametersClose + 1));
      return;
    }
    let segmentStart = parametersOpen + 1;
    const stack = [];
    const pairs = { "(": ")", "{": "}", "[": "]" };
    for (let index = segmentStart; index < parametersClose; index += 1) {
      const value = tokens[index]?.value;
      if (pairs[value]) stack.push(pairs[value]);
      else if (value === stack.at(-1)) stack.pop();
      else if (value === "," && stack.length === 0) {
        shadowBindingPattern(tokens.slice(segmentStart, index));
        segmentStart = index + 1;
      }
    }
    shadowBindingPattern(tokens.slice(segmentStart, parametersClose));
  };

  const bindSimpleDeclaration = (index) => {
    if (!["const", "let", "var"].includes(tokens[index]?.value)) return;
    const name = tokens[index + 1];
    if (["{", "["].includes(name?.value)) {
      const patternClose = closeIndex(tokens, index + 1);
      if (patternClose >= 0) shadowBindingPattern(tokens.slice(index + 1, patternClose + 1));
      return;
    }
    if (name?.kind !== "identifier") return;
    if (tokens[index + 2]?.value !== "=") {
      heartbeatAliasScopes.at(-1).set(name.value, false);
      databaseAliasScopes.at(-1).set(name.value, false);
      updateAliasScopes.at(-1).set(name.value, false);
      return;
    }
    const end = expressionEnd(tokens, index + 3, tokens.length);
    const value = tokens.slice(index + 3, end);
    bindingScopes.at(-1).set(name.value, value);
    const unwrapped = unwrap(value);
    heartbeatAliasScopes.at(-1).set(
      name.value,
      unwrapped.length === 1 && isHeartbeatAlias(unwrapped[0].value),
    );
    databaseAliasScopes.at(-1).set(
      name.value,
      unwrapped.length === 1 && isDatabaseAlias(unwrapped[0].value),
    );

    let memberUpdate = false;
    let computedDbOperation = false;
    for (let cursor = 0; cursor < unwrapped.length; cursor += 1) {
      const receiverIsDatabase = isDatabaseAlias(unwrapped[cursor]?.value);
      const isBound = (afterMember) =>
        unwrapped[afterMember]?.value === "." && unwrapped[afterMember + 1]?.value === "bind" &&
        unwrapped[afterMember + 2]?.value === "(";
      if (
        receiverIsDatabase && unwrapped[cursor + 1]?.value === "." && unwrapped[cursor + 2]?.value === "update" &&
        (cursor + 3 === unwrapped.length || isBound(cursor + 3))
      ) memberUpdate = true;
      if (
        receiverIsDatabase && unwrapped[cursor + 1]?.value === "[" &&
        unwrapped[cursor + 3]?.value === "]" &&
        (cursor + 4 === unwrapped.length || isBound(cursor + 4))
      ) {
        if (unwrapped[cursor + 2]?.kind === "string" && unwrapped[cursor + 2].value === "update") memberUpdate = true;
        else if (unwrapped[cursor + 2]?.kind !== "string") computedDbOperation = true;
      }
    }
    if (memberUpdate) updateAliasScopes.at(-1).set(name.value, "update");
    else if (computedDbOperation) updateAliasScopes.at(-1).set(name.value, "unknown");
    else updateAliasScopes.at(-1).set(name.value, false);
  };

  // Import aliases are bindings too: import { heartbeatRuns as runs } from ...
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (tokens[index]?.value !== "heartbeatRuns" || tokens[index + 1]?.value !== "as") continue;
    if (tokens[index + 2]?.kind === "identifier") heartbeatAliasScopes[0].set(tokens[index + 2].value, true);
  }

  for (let index = 0; index < tokens.length - 4; index += 1) {
    if (tokens[index].value === "{") {
      bindingScopes.push(new Map());
      heartbeatAliasScopes.push(new Map());
      databaseAliasScopes.push(new Map());
      updateAliasScopes.push(new Map());
      shadowParametersForBlock(index);
    } else if (tokens[index].value === "}" && bindingScopes.length > 1) {
      bindingScopes.pop();
      heartbeatAliasScopes.pop();
      databaseAliasScopes.pop();
      updateAliasScopes.pop();
    }
    bindSimpleDeclaration(index);

    let callOpen = -1;
    let operation = null;
    if (
      tokens[index].value === "." && tokens[index + 1]?.value === "update" && tokens[index + 2]?.value === "(" &&
      (tokens[index - 1]?.kind !== "identifier" || isDatabaseAlias(tokens[index - 1].value))
    ) {
      operation = "update";
      callOpen = index + 2;
    } else if (
      tokens[index].value === "[" && tokens[index + 1]?.kind === "string" &&
      tokens[index + 1].value === "update" && tokens[index + 2]?.value === "]" && tokens[index + 3]?.value === "(" &&
      (tokens[index - 1]?.kind !== "identifier" || isDatabaseAlias(tokens[index - 1].value))
    ) {
      operation = "update";
      callOpen = index + 3;
    } else if (
      tokens[index].value === "[" && tokens[index + 1]?.kind !== "string" &&
      tokens[index + 2]?.value === "]" && tokens[index + 3]?.value === "(" &&
      isDatabaseAlias(tokens[index - 1]?.value)
    ) {
      operation = "unknown";
      callOpen = index + 3;
    } else if (
      tokens[index].kind === "identifier" && resolveScoped(updateAliasScopes, tokens[index].value) &&
      tokens[index + 1]?.value === "("
    ) {
      operation = resolveScoped(updateAliasScopes, tokens[index].value);
      callOpen = index + 1;
    }
    if (callOpen < 0) continue;
    const callClose = closeIndex(tokens, callOpen);
    if (callClose < 0) continue;
    const tableArgument = unwrap(tokens.slice(callOpen + 1, callClose));
    if (tableArgument.length !== 1 || !isHeartbeatAlias(tableArgument[0].value)) continue;
    if (operation === "unknown") {
      findings.push({ index: tokens[index].start, reason: "database operation on heartbeatRuns is computed and not provably non-update" });
      continue;
    }
    let setIndex = -1;
    for (let cursor = callClose + 1; cursor < tokens.length - 2; cursor += 1) {
      if (tokens[cursor].value === ";" || (tokens[cursor].value === "." && tokens[cursor + 1].value === "update")) break;
      if (tokens[cursor].value === "." && tokens[cursor + 1].value === "set" && tokens[cursor + 2].value === "(") {
        setIndex = cursor + 2;
        break;
      }
      if (
        tokens[cursor].value === "[" && tokens[cursor + 1]?.kind === "string" &&
        tokens[cursor + 1].value === "set" && tokens[cursor + 2]?.value === "]" && tokens[cursor + 3]?.value === "("
      ) {
        setIndex = cursor + 3;
        break;
      }
    }
    if (setIndex < 0) {
      findings.push({ index: tokens[index].start, reason: "heartbeatRuns update has no structurally associated set call" });
      continue;
    }
    const setClose = closeIndex(tokens, setIndex);
    if (setClose < 0) {
      findings.push({ index: tokens[index].start, reason: "heartbeatRuns set call is unbalanced" });
      continue;
    }
    const reason = analyzeSetValue(tokens.slice(setIndex + 1, setClose), visibleBindings());
    if (reason) findings.push({ index: tokens[index].start, reason });
  }
  return findings;
}
