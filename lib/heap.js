// heap.js — a binary min-heap keyed on a float, with an int payload.
//
// Used by the priority flood in basins.js and by the least-cost river path
// in river.js. Written out rather than pulled in because it is forty lines
// and this repo has no dependencies.

export class Heap {
  constructor(cap = 64) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  _grow() {
    const k = new Float64Array(this.k.length * 2);
    const v = new Int32Array(this.v.length * 2);
    k.set(this.k);
    v.set(this.v);
    this.k = k;
    this.v = v;
  }
  push(key, val) {
    if (this.n === this.k.length) this._grow();
    let i = this.n++;
    this.k[i] = key;
    this.v[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop() {
    const top = this.v[0];
    this.n--;
    if (this.n > 0) {
      this.k[0] = this.k[this.n];
      this.v[0] = this.v[this.n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.k[l] < this.k[m]) m = l;
        if (r < this.n && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}
