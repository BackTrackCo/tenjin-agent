import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export default class RanMarker {
  constructor(options = {}) {
    this.task = options.task;
  }
  onInit(vitest) {
    this.root = vitest.config.root;
  }
  onTestRunEnd(modules, errors, reason) {
    const files = [];
    let passed = 0;
    let failed = 0;
    let green = reason === 'passed' && errors.length === 0;
    for (const module of modules) {
      files.push(relative(this.root, module.moduleId).split(sep).join('/'));
      if (module.state() !== 'passed') green = false;
      for (const test of module.children.allTests()) {
        const state = test.result().state;
        if (state === 'passed') passed += 1;
        else if (state === 'failed') failed += 1;
      }
    }
    if (!green || failed > 0 || passed === 0) return;
    files.sort();
    mkdirSync(join(this.root, '.bench1'), { recursive: true });
    writeFileSync(
      join(this.root, '.bench1', `ran-${this.task}.json`),
      JSON.stringify({ task: this.task, files, passed, failed }, null, 2) + '\n',
    );
  }
}
