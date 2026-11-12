import { describe, expect, it } from 'vitest';
import {
  estimateQueryPoints,
  GITHUB_SINGLE_QUERY_REQUESTS,
  githubBatchRequests,
  githubPointsForRequests,
} from '../src/index.js';

describe('query cost arithmetic (GitHub: connections / 100, rounded, minimum 1)', () => {
  it('reproduces the worked example of the GitHub documentation', () => {
    // 1 + 100 + 5 000 = 5 101 requests -> 51 points.
    expect(githubPointsForRequests(5101)).toBe(51);
    expect(githubPointsForRequests(0)).toBe(1);
    expect(githubPointsForRequests(149)).toBe(1);
    expect(githubPointsForRequests(150)).toBe(2);
  });

  it('counts the batch query as 11 requests per branch', () => {
    expect(githubBatchRequests(1)).toBe(11);
    expect(githubBatchRequests(20)).toBe(220);
  });

  it('a batch costs 1 point up to 13 branches and 2 from 14 to 20, then adds per chunk of 20', () => {
    const points = (n: number) => estimateQueryPoints('github', 'batch', n);
    expect(points(1)).toBe(1);
    expect(points(13)).toBe(1);
    expect(points(14)).toBe(2);
    expect(points(20)).toBe(2);
    expect(points(21)).toBe(2 + 1);
    expect(points(40)).toBe(4);
    expect(points(45)).toBe(2 + 2 + 1);
  });

  it('detail, conversation and repository queries cost 1 point each', () => {
    for (const kind of ['detail', 'conversation', 'repository'] as const) {
      expect(estimateQueryPoints('github', kind)).toBe(1);
    }
    expect(GITHUB_SINGLE_QUERY_REQUESTS.conversation).toBe(53);
  });

  it('counts GitLab by request, not by points', () => {
    expect(estimateQueryPoints('gitlab', 'batch', 1)).toBe(1);
    expect(estimateQueryPoints('gitlab', 'batch', 20)).toBe(1);
    expect(estimateQueryPoints('gitlab', 'batch', 21)).toBe(2);
    expect(estimateQueryPoints('gitlab', 'detail')).toBe(1);
  });
});
