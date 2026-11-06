export const MAX_LOOP = 10000;

const BACKSLASH = 92;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const OPEN_PARENTHESIS = 40;
const CLOSE_PARENTHESIS = 41;

// The searches below read the string only up to their result, unlike one
// `indexOf` per token, so splitting a string with repeated searches is linear.
const startsWithAny = (
  string: string,
  search: Array<string>,
  position: number,
): boolean => {
  const char = string.charCodeAt(position);
  for (let index = 0; index < search.length; index++) {
    const value = search[index];
    if (value.charCodeAt(0) === char && string.startsWith(value, position))
      return true;
  }
  return false;
};

/**
 * Find the first occurrence of any search string in the input string, ignoring escaped characters
 * @param string - The input string to search in
 * @param search - Array of strings to search for
 * @param position - Optional starting position for the search
 * @returns The index of the first match, or -1 if not found
 * @throws {Error} If too many escape sequences are encountered (> MAX_LOOP)
 * @example
 * ```ts
 * // Basic search
 * indexOfArrayNonEscaped('a,b,c', [',']) // 1
 *
 * // Handles escaped characters
 * indexOfArrayNonEscaped('a\\,b,c', [',']) // 4, the first comma is escaped
 * ```
 */
export const indexOfArrayNonEscaped = (
  string: string,
  search: Array<string>,
  position?: number,
): number => {
  let maxLoop = MAX_LOOP;
  for (let offset = Math.max(0, position ?? 0); offset < string.length; ) {
    if (string.charCodeAt(offset) === BACKSLASH) {
      if (--maxLoop === 0) throw new Error('Too many escaping');
      offset += 2;
    } else if (startsWithAny(string, search, offset)) {
      return offset;
    } else {
      offset++;
    }
  }
  return -1;
};

/**
 * Find the first occurrence of any search string in the input string, respecting brackets and quotes
 * @param string - The input string to search in
 * @param search - Array of strings to search for
 * @param position - Optional starting position for the search
 * @returns The index of the first match, or -1 if not found
 * @throws {Error} If too many escape sequences are encountered (> MAX_LOOP)
 * @example
 * ```ts
 * // Basic search
 * indexOfArrayWithBracketAndQuoteSupport('a,b,c', [',']) // 1
 *
 * // Respects brackets - won't match inside ()
 * indexOfArrayWithBracketAndQuoteSupport('(a,b),c', [',']) // 4, ignores the comma inside ()
 *
 * // Respects quotes - won't match inside quotes
 * indexOfArrayWithBracketAndQuoteSupport('"a,b",c', [',']) // 4, ignores the comma inside quotes
 * indexOfArrayWithBracketAndQuoteSupport("'a,b',c", [',']) // 4, ignores the comma inside quotes
 *
 * // Handles escaped characters
 * indexOfArrayWithBracketAndQuoteSupport('a\\,b,c', [',']) // 4, the first comma is escaped
 * ```
 */
export const indexOfArrayWithBracketAndQuoteSupport = (
  string: string,
  search: Array<string>,
  position?: number,
): number => {
  // Each `(` starts a nested search for its `)` with its own loop budget. The
  // enclosing budgets are kept on a stack instead of recursing, so deep
  // nesting cannot overflow the call stack.
  const enclosing: Array<number> = [];
  let budget = MAX_LOOP;
  for (let offset = Math.max(0, position ?? 0); offset < string.length; ) {
    const char = string.charCodeAt(offset);
    let end: number;
    if (char === BACKSLASH) {
      end = offset + 1;
    } else if (char === OPEN_PARENTHESIS) {
      enclosing.push(budget);
      budget = MAX_LOOP;
      offset++;
      continue;
    } else if (char === DOUBLE_QUOTE || char === SINGLE_QUOTE) {
      end = indexOfArrayNonEscaped(string, [string[offset]], offset + 1);
      if (end === -1) {
        return -1;
      }
    } else if (char === CLOSE_PARENTHESIS && enclosing.length > 0) {
      budget = enclosing.pop() as number;
      end = offset;
    } else if (
      enclosing.length === 0 &&
      startsWithAny(string, search, offset)
    ) {
      return offset;
    } else {
      offset++;
      continue;
    }
    if (--budget === 0) {
      throw new Error('Too many escaping');
    }
    offset = end + 1;
  }
  return -1;
};

/**
 * Split a string by search tokens, respecting brackets and quotes
 * @example
 * ```ts
 * splitWithBracketAndQuoteSupport('a,b', [',']) // ['a', 'b']
 * splitWithBracketAndQuoteSupport('a,(b,c)', [',']) // ['a', '(b,c)']
 * splitWithBracketAndQuoteSupport('a,"b,c"', [',']) // ['a', '"b,c"']
 * splitWithBracketAndQuoteSupport("a,'b,c'", [',']) // ['a', "'b,c'"]
 * ```
 */
export const splitWithBracketAndQuoteSupport = (
  string: string,
  search: Array<string>,
): Array<string> => {
  const result: Array<string> = [];
  let currentPosition = 0;
  while (currentPosition < string.length) {
    const index = indexOfArrayWithBracketAndQuoteSupport(
      string,
      search,
      currentPosition,
    );
    if (index === -1) {
      result.push(string.substring(currentPosition));
      return result;
    }
    result.push(string.substring(currentPosition, index));
    currentPosition = index + 1;
  }
  return result;
};
