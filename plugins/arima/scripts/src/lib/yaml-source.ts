import { readFileSync } from 'node:fs';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Document, Node } from 'yaml';

/** A parsed YAML file that can map JSON pointers back to 1-based line numbers. */
export class YamlSource {
  readonly file: string;
  readonly doc: Document.Parsed;
  readonly lines = new LineCounter();
  readonly parseErrors: { line: number; message: string }[] = [];

  constructor(file: string, text: string = readFileSync(file, 'utf8')) {
    this.file = file;
    this.doc = parseDocument(text, { lineCounter: this.lines, prettyErrors: false });
    for (const e of this.doc.errors) {
      this.parseErrors.push({
        line: e.linePos?.[0]?.line ?? 1,
        message: e.message.split('\n')[0] ?? e.message,
      });
    }
  }

  get data(): unknown {
    return this.doc.toJS();
  }

  /** 1-based line of a JSON pointer ("/roles/po"), falling back to the nearest existing parent. */
  lineOf(pointer: string): number {
    const parts = pointer
      .split('/')
      .filter(Boolean)
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let node: unknown = this.doc.contents;
    let best: Node | null = this.doc.contents ?? null;
    for (const part of parts) {
      if (isMap(node)) {
        const pair = node.items.find((i) => isScalar(i.key) && String(i.key.value) === part);
        if (!pair) break;
        node = pair.value;
        if (isScalar(pair.key) && pair.key.range) best = pair.key;
      } else if (isSeq(node)) {
        node = node.items[Number(part)];
        const n = node as Node | undefined;
        if (n?.range) best = n;
      } else break;
    }
    const offset = best?.range?.[0] ?? 0;
    return this.lines.linePos(offset).line;
  }
}
