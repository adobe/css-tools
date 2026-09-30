export const MAX_LOOP = 10000;

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
  let currentPosition = position;
  let maxLoop = MAX_LOOP;
  do {
    const all = search.map((v) => string.indexOf(v, currentPosition));
    all.push(string.indexOf('\\', currentPosition));
    const foundAll = all.filter((v) => v !== -1);
    if (foundAll.length === 0) {
      return -1;
    }

    const found = Math.min(...foundAll);
    if (string[found] === '\\') {
      currentPosition = found + 2;
      maxLoop--;
    } else {
      return found;
    }
  } while (maxLoop > 0);

  throw new Error('Too many escaping');
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
  let currentSearchPosition = position;
  let maxLoop = MAX_LOOP;

  do {
    const all = search.map((v) => string.indexOf(v, currentSearchPosition));

    all.push(string.indexOf('(', currentSearchPosition));
    all.push(string.indexOf('"', currentSearchPosition));
    all.push(string.indexOf("'", currentSearchPosition));
    all.push(string.indexOf('\\', currentSearchPosition));

    const foundAll = all.filter((v) => v !== -1);
    if (foundAll.length === 0) {
      return -1;
    }

    const firstMatchPos = Math.min(...foundAll);
    const char = string[firstMatchPos];
    switch (char) {
      case '\\':
        currentSearchPosition = firstMatchPos + 2;
        break;
      case '(':
        {
          const endPosition = indexOfArrayWithBracketAndQuoteSupport(
            string,
            [')'],
            firstMatchPos + 1,
          );
          if (endPosition === -1) {
            return -1;
          }
          currentSearchPosition = endPosition + 1;
        }
        break;
      case '"':
        {
          const endQuotePosition = indexOfArrayNonEscaped(
            string,
            ['"'],
            firstMatchPos + 1,
          );
          if (endQuotePosition === -1) {
            return -1;
          }
          currentSearchPosition = endQuotePosition + 1;
        }
        break;
      case "'":
        {
          const endQuotePosition = indexOfArrayNonEscaped(
            string,
            ["'"],
            firstMatchPos + 1,
          );
          if (endQuotePosition === -1) {
            return -1;
          }
          currentSearchPosition = endQuotePosition + 1;
        }
        break;
      default:
        return firstMatchPos;
    }
    maxLoop--;
  } while (maxLoop > 0);

  throw new Error('Too many escaping');
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

/**
 * Remove `/* ... *\/` comments from a string while preserving the content of
 * quoted strings. A `/*` inside a quoted string does not start a comment, so
 * comment-like text in an attribute-selector value must be kept verbatim.
 * @example
 * ```ts
 * removeCommentWithQuoteSupport('a /*c*\/ b') // 'a  b'
 * removeCommentWithQuoteSupport('a[title="/*x*\/"]') // 'a[title="/*x*\/"]'
 * ```
 */
export const removeCommentWithQuoteSupport = (string: string): string => {
  let result = '';
  let currentPosition = 0;
  let maxLoop = MAX_LOOP;

  while (currentPosition < string.length && maxLoop > 0) {
    const all = [
      string.indexOf('/*', currentPosition),
      string.indexOf('"', currentPosition),
      string.indexOf("'", currentPosition),
    ].filter((v) => v !== -1);

    if (all.length === 0) {
      result += string.substring(currentPosition);
      return result;
    }

    const firstMatchPos = Math.min(...all);
    result += string.substring(currentPosition, firstMatchPos);
    const char = string[firstMatchPos];

    if (char === '/') {
      const endComment = string.indexOf('*/', firstMatchPos + 2);
      if (endComment === -1) {
        return result;
      }
      currentPosition = endComment + 2;
    } else {
      const endQuotePosition = indexOfArrayNonEscaped(
        string,
        [char],
        firstMatchPos + 1,
      );
      if (endQuotePosition === -1) {
        result += string.substring(firstMatchPos);
        return result;
      }
      result += string.substring(firstMatchPos, endQuotePosition + 1);
      currentPosition = endQuotePosition + 1;
    }
    maxLoop--;
  }

  if (maxLoop <= 0) {
    throw new Error('Too many escaping');
  }

  return result;
};
