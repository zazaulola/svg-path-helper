import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseXml, elementAt, getAttr, transformElementAt,
  inlineStyle, geomProp, descendantElements, directChildElements,
} from '../src/svgTree';

describe('svgTree — parsing', () => {
  test('element, attributes and value ranges', () => {
    const t = '<rect x="1" y="2"/>';
    const el = parseXml(t).children[0];
    assert.equal(el.tag, 'rect');
    assert.equal(el.selfClosing, true);
    const x = getAttr(el, 'x')!;
    assert.equal(t.slice(x.valueStart, x.valueEnd), '1');
  });

  test('nesting + elementAt resolves the deepest element', () => {
    const t = '<g><rect/></g>';
    const at = elementAt(parseXml(t), t.indexOf('rect') + 1);
    assert.equal(at!.tag, 'rect');
  });

  test('comments, CDATA and doctype are typed nodes', () => {
    const t = '<!-- c --><![CDATA[ x ]]><svg/>';
    const c = parseXml(t).children;
    assert.deepEqual(c.map((n) => n.type), ['comment', 'cdata', 'element']);
  });

  test('descendant / direct-child helpers', () => {
    const root = parseXml('<g><a><rect/></a><circle/></g>');
    const g = root.children[0];
    assert.deepEqual(directChildElements(g).map((e) => e.tag), ['a', 'circle']);
    assert.deepEqual(descendantElements(g).map((e) => e.tag), ['a', 'rect', 'circle']);
  });

  test('transformElementAt finds the element whose transform value holds the offset', () => {
    const t = '<g transform="rotate(9)"><rect/></g>';
    const off = t.indexOf('rotate');
    assert.equal(transformElementAt(parseXml(t), off, off)!.el.tag, 'g');
    // not on a transform -> undefined
    assert.equal(transformElementAt(parseXml(t), t.indexOf('rect'), t.indexOf('rect')), undefined);
  });

  test('inlineStyle + geomProp fall back to inline style', () => {
    const el = parseXml('<rect style="width:40px; fill:red" height="10"/>').children[0];
    assert.deepEqual(inlineStyle(el), { width: '40px', fill: 'red' });
    assert.equal(geomProp(el, inlineStyle(el), 'width'), '40px');
    assert.equal(geomProp(el, inlineStyle(el), 'height'), '10'); // attribute wins / present
  });
});

describe('svgTree — robustness (review regressions)', () => {
  test('unclosed element end covers its children', () => {
    const t = '<svg><g><rect/></svg>';
    const root = parseXml(t);
    const g = root.children[0].children[0];
    assert.equal(g.closed, false);
    assert.ok(g.end >= g.children[0].end, 'g.end must cover <rect/>');
  });

  test('unquoted value before /> keeps self-closing', () => {
    const el = parseXml('<rect width=100/>').children[0];
    assert.equal(el.selfClosing, true);
    assert.equal(getAttr(el, 'width')!.value, '100');
  });

  test('DOCTYPE with internal subset does not shift following offsets', () => {
    const t = '<!DOCTYPE svg [ <!ENTITY x "y"> ]><svg/>';
    const c = parseXml(t).children;
    assert.equal(c[0].type, 'doctype');
    assert.equal(c[1].tag, 'svg');
  });

  test('whitespace in the closing tag: innerEnd excludes it', () => {
    const t = '<g>x</g >';
    const g = parseXml(t).children[0];
    assert.equal(t.slice(g.openEnd, g.innerEnd), 'x');
    assert.equal(g.closed, true);
  });
});
