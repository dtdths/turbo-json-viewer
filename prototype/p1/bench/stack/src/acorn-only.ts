/** Size probe: acorn alone (parse + AST types used by a whitelist walker). */
import * as acorn from 'acorn';
export const parseExpression = (src: string) => acorn.parse(src, { ecmaVersion: 2022 });
export const version = acorn.version;
