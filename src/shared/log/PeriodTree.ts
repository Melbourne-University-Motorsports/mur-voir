// Copyright (c) 2026 Melbourne University Motorsports. Based on AdvantageScope (BSD-3-Clause, © Littleton Robotics).
// https://github.com/Melbourne-University-Motorsports/mur-voir
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

type Node = {
  period: number;
  count: number;
  size: number;
  height: number;
  left?: Node;
  right?: Node;
};

function refresh(node: Node) {
  node.height = 1 + Math.max(node.left?.height ?? 0, node.right?.height ?? 0);
  node.size = node.count + (node.left?.size ?? 0) + (node.right?.size ?? 0);
}

function balance(node: Node): number {
  return (node.left?.height ?? 0) - (node.right?.height ?? 0);
}

function rotateLeft(node: Node): Node {
  const right = node.right!;
  node.right = right.left;
  right.left = node;
  refresh(node);
  refresh(right);
  return right;
}

function rotateRight(node: Node): Node {
  const left = node.left!;
  node.left = left.right;
  left.right = node;
  refresh(node);
  refresh(left);
  return left;
}

/** An AVL tree with multiplicities and subtree sizes for exact period ranks. */
export default class PeriodTree {
  private root?: Node;

  get size(): number {
    return this.root?.size ?? 0;
  }

  clear() {
    this.root = undefined;
  }

  change(period: number, delta: 1 | -1) {
    this.root = this.adjust(this.root, period, delta);
  }

  private adjust(node: Node | undefined, period: number, delta: number): Node | undefined {
    if (!node) return delta > 0 ? { period, count: delta, size: delta, height: 1 } : undefined;
    if (period < node.period) {
      node.left = this.adjust(node.left, period, delta);
    } else if (period > node.period) {
      node.right = this.adjust(node.right, period, delta);
    } else {
      node.count += delta;
      if (!node.count) {
        if (!node.left) return node.right;
        if (!node.right) return node.left;
        let next = node.right;
        while (next.left) next = next.left;
        node.period = next.period;
        node.count = next.count;
        node.right = this.adjust(node.right, next.period, -next.count);
      }
    }
    refresh(node);
    const tilt = balance(node);
    if (tilt > 1) {
      if (balance(node.left!) < 0) node.left = rotateLeft(node.left!);
      return rotateRight(node);
    }
    if (tilt < -1) {
      if (balance(node.right!) > 0) node.right = rotateRight(node.right!);
      return rotateLeft(node);
    }
    return node;
  }

  at(rank: number): number {
    let node = this.root!;
    while (true) {
      const leftSize = node.left?.size ?? 0;
      if (rank < leftSize) {
        node = node.left!;
      } else if (rank < leftSize + node.count) {
        return node.period;
      } else {
        rank -= leftSize + node.count;
        node = node.right!;
      }
    }
  }
}
