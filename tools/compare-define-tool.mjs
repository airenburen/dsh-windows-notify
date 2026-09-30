/**
 * 用 DSH 自带的 defineTool 对照校验本地实现产出完全相同的 schema。
 *
 * 用法（真实实现的路径由运行者在 profile 上下文里解析后通过环境变量传入）：
 *   REAL_DSH_TOOLS=<file url> node tools/compare-define-tool.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { defineTool as localDefineTool } from '../lib/define-tool.js';

const realPath = process.env.REAL_DSH_TOOLS;
if (realPath === undefined || realPath === '') {
  console.error('缺少 REAL_DSH_TOOLS（@deepseek-ai/dsh-tools 入口的绝对路径或 file URL）');
  process.exit(2);
}
const realUrl = realPath.startsWith('file:') ? realPath : pathToFileURL(realPath).href;
const { defineTool: realDefineTool } = await import(realUrl);
console.log(`real defineTool: ${realUrl}`);

const cases = [
  {
    label: '插件的 notify_user 定义',
    options: {
      name: 'notify_user',
      description: 'desc',
      parameters: {
        title: { type: 'string', required: true, description: 't' },
        message: { type: 'string', required: true, description: 'm' },
        tag: { type: 'string', description: 'tag' },
        silent: { type: 'boolean', description: 's' },
        sticky: { type: 'boolean', description: 'st' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true, description: 'd' },
            title: { type: 'string', required: true },
            body: { type: 'string', required: true },
            skipped: { type: 'string', description: 'sk' },
            error: { type: 'string', description: 'e' },
          },
        },
        render: () => [],
      },
      execute: async () => ({}),
    },
  },
  {
    label: '嵌套对象 / 数组 / 枚举 / oneOf',
    options: {
      name: 'kitchen_sink',
      description: 'desc',
      parameters: {
        plain: { type: 'string' },
        num: { type: 'number', required: true, description: 'n' },
        int: { type: 'integer' },
        flagged: { type: 'boolean', required: true },
        choice: { type: 'string', enum: ['a', 'b'] },
        fixed: { type: 'string', const: 'x' },
        list: { type: 'array', items: { type: 'string' } },
        nested: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            inner: { type: 'string', required: true },
            deeper: {
              type: 'object',
              additionalProperties: false,
              properties: { leaf: { type: 'integer', required: true } },
            },
          },
        },
        either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        anything: { type: 'json' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [],
      },
      execute: async () => ({ ok: true }),
    },
  },
];

let passed = 0;
for (const testCase of cases) {
  const real = realDefineTool(testCase.options);
  const local = localDefineTool(testCase.options);
  assert.deepEqual(local.parameters, real.parameters, `${testCase.label}: parameters 不一致`);
  assert.deepEqual(local.output.schema, real.output.schema, `${testCase.label}: output.schema 不一致`);
  assert.equal(local.name, real.name);
  passed += 1;
  console.log(`  ok  ${testCase.label}`);
  console.log(`      parameters = ${JSON.stringify(local.parameters)}`);
}

// 作者侧错误也必须同样被拒
const bad = [
  { parameters: { a: { type: 'string', required: false } }, label: 'required:false' },
  { parameters: { a: { type: 'object', properties: {} } }, label: 'object 缺 additionalProperties' },
  { parameters: { a: { type: 'nope' } }, label: '未知 type' },
  { parameters: { a: { type: 'string', unknown: 1 } }, label: '未知作者键' },
  { parameters: { a: { oneOf: [{ type: 'string' }] } }, label: 'oneOf 少于两支' },
];
for (const item of bad) {
  const options = { name: 'bad', description: 'd', parameters: item.parameters, output: { schema: { type: 'json' }, render: () => [] }, execute: async () => ({}) };
  let realThrew = false;
  let localThrew = false;
  try {
    realDefineTool(options);
  } catch {
    realThrew = true;
  }
  try {
    localDefineTool(options);
  } catch {
    localThrew = true;
  }
  assert.equal(localThrew, realThrew, `${item.label}: 拒绝行为与真实实现不一致（real=${String(realThrew)} local=${String(localThrew)}）`);
  passed += 1;
  console.log(`  ok  同样拒绝：${item.label}（两者都${realThrew ? '抛错' : '通过'}）`);
}

console.log(`\n${passed} comparisons passed.`);
