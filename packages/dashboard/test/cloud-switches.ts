// The inline switches on the cloud in the dashboard's sources, as the cloud-words test reads them (CloudWords.test.ts): a
// conditional (`… ? … : …`) whose test is on the cloud, an `if` on the cloud that returns a text, an object keyed by both
// clouds, and two elements of one tag shown one on a cloud test and the other otherwise (v-if, then v-else-if or v-else).
// A test on the cloud: a comparison with 'aws' or 'gcp', or a view's flag for Google Cloud (`gcp`, `google`, `isGoogle(…)`).
// Scripts and template expressions are read with TypeScript's parser, templates with Vue's, so a switch is found whatever its
// layout.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { parse } from 'vue/compiler-sfc';

export interface Switch { file: string; line: number; text: string }

const FLAGS = new Set(['gcp', 'google', 'isGoogle']);
const EQUALITIES = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const isCloud = (node: ts.Node) => ts.isStringLiteralLike(node) && (node.text === 'aws' || node.text === 'gcp');

function testsCloud(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && EQUALITIES.has(node.operatorToken.kind) && (isCloud(node.left) || isCloud(node.right))) return true;
  if (ts.isIdentifier(node)) return FLAGS.has(node.text);
  // `x.gcp` names a property, not the flag.
  if (ts.isPropertyAccessExpression(node)) return testsCloud(node.expression);
  return ts.forEachChild(node, testsCloud) ?? false;
}

const isText = (node: ts.Node | undefined) => Boolean(node && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)));
// `return '…'` or `{ return '…'; }`.
function returnsText(node: ts.Statement): boolean {
  const statement = ts.isBlock(node) && node.statements.length === 1 ? node.statements[0]! : node;
  return ts.isReturnStatement(statement) && isText(statement.expression);
}
const nameOf = (p: ts.ObjectLiteralElementLike) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null);
const keyedByClouds = (node: ts.ObjectLiteralExpression) => ['aws', 'gcp'].every((cloud) => node.properties.some((p) => nameOf(p) === cloud));

// The switches of a script or of a template expression whose first line is `line`.
function scanScript(file: string, code: string, line: number, found: Switch[]) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const add = (node: ts.Node, text = node.getText(source)) => found.push({ file, line: line + source.getLineAndCharacterOfPosition(node.getStart(source)).line, text: squash(text) });
  const visit = (node: ts.Node): void => {
    if (ts.isConditionalExpression(node) && testsCloud(node.condition)) add(node);
    else if (ts.isIfStatement(node) && testsCloud(node.expression) && returnsText(node.thenStatement)) add(node, `if (${node.expression.getText(source)})`);
    else if (ts.isObjectLiteralExpression(node) && keyedByClouds(node)) add(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const testsCloudIn = (code: string) => testsCloud(ts.createSourceFile('exp.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));

// Vue's template AST, as far as this reads it (@vue/compiler-core's node types 1, 5 and 7).
interface Expression { content: string; loc: { start: { line: number } } }
interface Directive { type: 7; name: string; exp?: Expression }
interface Element { type: 1; tag: string; props: ({ type: 6 } | Directive)[]; children: Node[]; loc: { start: { line: number } } }
type Node = Element | { type: 5; content: Expression } | { type: 2 | 3 | 4 | 8 | 12 };
const directive = (el: Element, ...names: string[]) => el.props.find((p): p is Directive => p.type === 7 && names.includes(p.name));

function scanTemplate(file: string, nodes: Node[], found: Switch[]) {
  const elements = nodes.filter((n): n is Element => n.type === 1);
  elements.forEach((el, i) => {
    const shown = directive(el, 'if', 'else-if');
    const next = elements[i + 1];
    if (shown?.exp && testsCloudIn(shown.exp.content) && next?.tag === el.tag && directive(next, 'else-if', 'else')) {
      found.push({ file, line: el.loc.start.line, text: `<${el.tag} v-${shown.name}="${squash(shown.exp.content)}">` });
    }
  });
  for (const node of nodes) {
    if (node.type === 5) scanScript(file, node.content.content, node.content.loc.start.line, found);
    if (node.type !== 1) continue;
    // A v-for's `x in xs` and a slot's props are not expressions.
    for (const p of node.props) if (p.type === 7 && p.exp && p.name !== 'for' && p.name !== 'slot') scanScript(file, p.exp.content, p.exp.loc.start.line, found);
    scanTemplate(file, node.children, found);
  }
}

// The switches of one source file, by its path (`.vue` or `.ts`) and text.
export function scanFile(file: string, text: string): Switch[] {
  const found: Switch[] = [];
  if (!file.endsWith('.vue')) {
    scanScript(file, text, 1, found);
    return found;
  }
  const { descriptor } = parse(text, { filename: file });
  for (const block of [descriptor.script, descriptor.scriptSetup]) if (block) scanScript(file, block.content, block.loc.start.line, found);
  if (descriptor.template?.ast) scanTemplate(file, descriptor.template.ast.children as unknown as Node[], found);
  return found;
}

// Every source of the dashboard (`src`, its paths relative to it) but those `skip` names.
export function scanSources(skip: (file: string) => boolean): Switch[] {
  const src = resolve(import.meta.dirname, '../src');
  return (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.(ts|vue)$/.test(f) && !skip(f)).sort()
    .flatMap((f) => scanFile(f, readFileSync(resolve(src, f), 'utf8')));
}
