import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransformEdits, cursorOnTransform, OpKind } from '../src/transformOps';
import { applyEdits } from './_helpers';

function runOp(svg: string, marker: string, kind: OpKind, prec = 3): string {
  const at = svg.indexOf(marker) + marker.length + 1; // inside the transform value
  return applyEdits(svg, buildTransformEdits(svg, at, at, kind, prec));
}

describe('transformOps — the four operations', () => {
  test('op1: convert this transform to matrix()', () => {
    assert.equal(
      runOp('<g transform="translate(10 20) rotate(90)"><rect/></g>', 'transform="', 'toMatrix'),
      '<g transform="matrix(0 1 -1 0 10 20)"><rect/></g>',
    );
  });

  test('op2: convert nested transforms to matrix() (each individually)', () => {
    assert.equal(
      runOp('<g transform="scale(2)"><g transform="translate(5 5)"><rect/></g></g>', 'transform="', 'toMatrixDeep'),
      '<g transform="matrix(2 0 0 2 0 0)"><g transform="matrix(1 0 0 1 5 5)"><rect/></g></g>',
    );
  });

  test('op3: resolve bakes a shape into a transform-free <path>', () => {
    assert.equal(
      runOp('<rect transform="translate(5 5)" x="0" y="0" width="10" height="10" fill="red"/>', 'transform="', 'resolve'),
      '<path fill="red" d="M 5 5 H 15 V 15 H 5 Z"/>',
    );
  });

  test('op3: resolve on a <g> pushes one level into direct children', () => {
    assert.equal(
      runOp('<g transform="scale(2)"><rect x="0" y="0" width="5" height="5"/><g transform="rotate(10)"><circle/></g></g>', 'transform="', 'resolve'),
      '<g><path d="M 0 0 H 10 V 10 H 0 Z"/><g transform="matrix(2 0 0 2 0 0) rotate(10)"><circle/></g></g>',
    );
  });

  test('op3: nested grandchild transform is preserved (composed), not flattened', () => {
    assert.equal(
      runOp('<g transform="translate(1 1)"><g transform="translate(2 2)"><rect x="0" y="0" width="1" height="1"/></g></g>', 'transform="', 'resolve'),
      '<g><g transform="matrix(1 0 0 1 1 1) translate(2 2)"><rect x="0" y="0" width="1" height="1"/></g></g>',
    );
  });

  test('op4: resolveDeep flattens the whole subtree (no transforms remain)', () => {
    assert.equal(
      runOp('<g transform="translate(10 10)"><g transform="scale(2)"><rect x="0" y="0" width="5" height="5"/></g></g>', 'transform="', 'resolveDeep'),
      '<g><g><path d="M 10 10 H 20 V 20 H 10 Z"/></g></g>',
    );
  });

  test('op4: opaque element (text) keeps the accumulated matrix as its own transform', () => {
    assert.equal(
      runOp('<g transform="translate(3 4)"><text transform="scale(2)">hi</text></g>', 'transform="', 'resolveDeep'),
      '<g><text transform="matrix(2 0 0 2 3 4)">hi</text></g>',
    );
  });

  test('attributes and styling are carried onto the generated <path>', () => {
    assert.equal(
      runOp('<circle transform="translate(10 10)" cx="0" cy="0" r="5" fill="#abc" class="dot"/>', 'transform="', 'resolve'),
      '<path fill="#abc" class="dot" d="M 5 10 A 5 5 0 1 0 15 10 A 5 5 0 1 0 5 10 Z"/>',
    );
  });
});

describe('transformOps — robustness (review regressions)', () => {
  test('unclosed element is not duplicated on resolveDeep', () => {
    assert.equal(
      runOp('<svg><g transform="scale(2)"><rect x="0" y="0" width="3" height="3"/></svg>', 'transform="', 'resolveDeep'),
      '<svg><g><path d="M 0 0 H 6 V 6 H 0 Z"/></svg>',
    );
  });

  test('whitespace in closing tag does not leak into reserialized content', () => {
    assert.equal(
      runOp('<g transform="translate(5 5)"><rect x="0" y="0" width="2" height="2"/></g >', 'transform="', 'resolveDeep'),
      '<g><path d="M 5 5 H 7 V 7 H 5 Z"/></g>',
    );
  });

  test('unquoted self-closing value does not swallow the following sibling', () => {
    assert.equal(
      runOp('<rect transform=scale(2) x=0 y=0 width=4 height=4/><circle/>', 'transform=', 'resolve'),
      '<path d="M 0 0 H 8 V 8 H 0 Z"/><circle/>',
    );
  });
});

describe('transformOps — context-key detection', () => {
  test('real transform value is detected', () => {
    const s = '<g transform="rotate(9)"><rect/></g>';
    const at = s.indexOf('rotate(9)');
    assert.equal(cursorOnTransform(s, at, at), true);
  });

  test('transform="…" inside a comment is NOT detected', () => {
    const s = '<svg><!-- transform="rotate(9)" --><rect/></svg>';
    const at = s.indexOf('rotate(9)');
    assert.equal(cursorOnTransform(s, at, at), false);
  });

  test('gradientTransform is not mistaken for transform', () => {
    const s = '<linearGradient gradientTransform="rotate(9)"/>';
    const at = s.indexOf('rotate(9)');
    assert.equal(cursorOnTransform(s, at, at), false);
  });

  test('no transform under cursor -> no edits', () => {
    assert.equal(buildTransformEdits('<rect x="0"/>', 5, 5, 'toMatrix', 3), null);
  });
});
