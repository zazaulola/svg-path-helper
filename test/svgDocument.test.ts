import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findPaths, extractSvg, tagSvg, elementIdAt, svgPaths } from '../src/svgDocument';

describe('svgDocument — tagSvg', () => {
  test('tags every element with data-sph-el and d-bearing paths with data-sph-idx', () => {
    const svg = '<svg><rect/><g><path d="M0 0"/></g></svg>';
    assert.equal(
      tagSvg(svg),
      '<svg data-sph-el="0"><rect data-sph-el="1"/><g data-sph-el="2"><path data-sph-el="3" data-sph-idx="0" d="M0 0"/></g></svg>',
    );
  });

  test('data-sph-idx counts only d-bearing paths, in document order', () => {
    const svg = '<svg><path fill="red"/><path d="M1 1"/><path d="M2 2"/></svg>';
    const out = tagSvg(svg);
    // decorative path (no d) gets data-sph-el but NOT data-sph-idx
    assert.ok(/<path data-sph-el="1" fill="red"\/>/.test(out), out);
    assert.ok(/<path data-sph-el="2" data-sph-idx="0" d="M1 1"\/>/.test(out), out);
    assert.ok(/<path data-sph-el="3" data-sph-idx="1" d="M2 2"\/>/.test(out), out);
  });

  test('camelCase tag names keep correct insertion offset', () => {
    const out = tagSvg('<svg><linearGradient id="g"/></svg>');
    assert.ok(out.includes('<linearGradient data-sph-el="1" id="g"/>'), out);
  });
});

describe('svgDocument — elementIdAt', () => {
  const svg = '<svg><rect/><g><path d="M0 0"/></g></svg>';
  test('resolves the deepest element containing the offset', () => {
    assert.equal(elementIdAt(svg, svg.indexOf('d="M0 0"') + 1), 3); // inside the path
    assert.equal(elementIdAt(svg, svg.indexOf('<rect') + 2), 1);    // inside the rect tag
    assert.equal(elementIdAt(svg, 1), 0);                            // only the <svg> tag
  });

  test('data-sph-el id from tagSvg matches elementIdAt', () => {
    // the path is data-sph-el="3" in tagSvg AND elementIdAt returns 3 for a cursor in it
    const id = elementIdAt(svg, svg.indexOf('M0 0'));
    assert.ok(tagSvg(svg).includes(`data-sph-el="${id}" data-sph-idx="0" d="M0 0"`));
  });
});

describe('svgDocument — svgPaths matches tagSvg (review regressions)', () => {
  test('commented-out <path> is skipped, indices match data-sph-idx', () => {
    const svg = '<svg><!-- <path d="M9 9"/> --><path d="M0 0"/><path d="M1 1"/></svg>';
    const ps = svgPaths(svg);
    assert.deepEqual(ps.map((p) => p.dText), ['M0 0', 'M1 1']); // commented path not counted
    assert.equal(svg.slice(ps[0].dStart, ps[0].dStart + ps[0].dText.length), 'M0 0');
    const tagged = tagSvg(extractSvg(svg)!.svg);
    assert.ok(tagged.includes('data-sph-idx="0" d="M0 0"'));
    assert.ok(tagged.includes('data-sph-idx="1" d="M1 1"'));
  });

  test('tagSvg does not inject into <style>/<script> bodies', () => {
    assert.equal(
      tagSvg('<svg><style>.a::after{content:"<g>"}</style><rect/></svg>'),
      '<svg data-sph-el="0"><style data-sph-el="1">.a::after{content:"<g>"}</style><rect data-sph-el="2"/></svg>',
    );
    // a <path> inside <style> is not a real element and is not counted
    assert.equal(svgPaths('<svg><style>path{d:"<path d=\'M0 0\'/>"}</style><path d="M2 2"/></svg>').length, 1);
  });
});

describe('svgDocument — extractSvg / findPaths still work', () => {
  test('extractSvg returns region + offset', () => {
    const r = extractSvg('x\n<svg><path d="M0 0"/></svg>');
    assert.equal(r!.start, 2);
    assert.ok(r!.svg.startsWith('<svg>'));
  });
  test('findPaths locates d attributes', () => {
    assert.equal(findPaths('<svg><path d="M0 0 L1 1"/></svg>').length, 1);
  });
});
