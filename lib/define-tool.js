/**
 * 本地实现的 `defineTool`（等价于 @deepseek-ai/dsh-tools 的同名辅助函数）。
 *
 * 为什么复制这一小段：插件以 `link:` 方式装进 profile 时，Node 会按真实路径解析
 * 插件内部的裸导入，`@deepseek-ai/dsh-tools` 未必能从那里解析到；而它提供的
 * `defineTool` 只是一段把「作者侧 schema 描述」编译成注册表要的原始 JSON Schema
 * 的纯函数。这里按同一算法实现，让插件只保留 schemastery 一个可选依赖。
 *
 * 作者侧写法（与内置工具一致）：
 *   parameters: { title: { type: 'string', required: true, description: '…' } }
 * 编译结果（注册表实际校验的形状）：
 *   { type: 'object', properties: { title: { type: 'string', description: '…' } }, required: ['title'] }
 *
 * @module dsh-windows-notify/define-tool
 */

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authorError(message) {
  const error = new Error(message);
  error.name = 'JsonSchemaError';
  return error;
}

function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw authorError(`${path}.${key} is not supported by the value schema DSL`);
  }
}

function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
}

/**
 * 编译一个作者侧 value schema。
 * @param {object} input - 作者侧节点
 * @param {string} path - 报错用的路径
 * @param {boolean} allowRequired - 该节点是否允许 `required: true`
 * @returns {object} 原始 JSON Schema 节点
 */
function compileValue(input, path, allowRequired) {
  if (!isRecord(input)) throw authorError(`${path} must be a value schema object`);
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])];
  const node = {};

  if (Object.hasOwn(input, 'oneOf')) {
    assertAuthorKeys(input, path, [...authorKeys, 'oneOf', 'type']);
    if (Object.hasOwn(input, 'type')) throw authorError(`${path} cannot declare both type and oneOf`);
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      throw authorError(`${path}.oneOf must be an array of at least two value schemas`);
    }
    copyAnnotations(input, node);
    node.oneOf = input.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`, false));
    return node;
  }

  switch (input.type) {
    case 'json':
      assertAuthorKeys(input, path, [...authorKeys, 'type']);
      copyAnnotations(input, node);
      return node;
    case 'object': {
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties']);
      if (typeof input.additionalProperties !== 'boolean') {
        throw authorError(`${path}.additionalProperties must be explicitly true or false`);
      }
      node.type = 'object';
      copyAnnotations(input, node);
      node.additionalProperties = input.additionalProperties;
      if (Object.hasOwn(input, 'properties')) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`);
        node.properties = compiled.properties;
        if (compiled.required !== undefined) node.required = compiled.required;
      }
      return node;
    }
    case 'array':
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'items']);
      node.type = 'array';
      copyAnnotations(input, node);
      if (Object.hasOwn(input, 'items')) node.items = compileValue(input.items, `${path}.items`, false);
      return node;
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const']);
      node.type = input.type;
      copyAnnotations(input, node);
      if (Object.hasOwn(input, 'enum')) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) {
          throw authorError(`${path}.enum must be a non-empty array of scalar values`);
        }
        node.enum = [...input.enum];
      }
      if (Object.hasOwn(input, 'const')) node.const = input.const;
      return node;
    default:
      throw authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
  }
}

/**
 * 编译一个属性表，收集 `required: true` 的键。
 * @param {object} input - 属性表
 * @param {string} path - 报错路径
 * @returns {{properties: object, required?: string[]}}
 */
function compilePropertyMap(input, path) {
  if (!isRecord(input)) throw authorError(`${path} must be an object of value schemas`);
  const properties = {};
  const required = [];
  for (const [key, property] of Object.entries(input)) {
    const propertyPath = `${path}.${key}`;
    if (!isRecord(property)) throw authorError(`${propertyPath} must be a value schema object`);
    if (Object.hasOwn(property, 'required') && property.required !== true) {
      throw authorError(`${propertyPath}.required must be true when present`);
    }
    if (property.required === true) required.push(key);
    properties[key] = compileValue(property, propertyPath, true);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/** 作者侧参数表 → 注册表要的对象根 schema。 */
export function parameterSchemaSpecToJsonSchema(spec) {
  const compiled = compilePropertyMap(spec, 'parameters');
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  };
}

/**
 * 构造一个注册表可用的工具定义（等价于 @deepseek-ai/dsh-tools 的 defineTool）。
 * @param {{name: string, description: string, parameters: object,
 *   output: {schema: object, render: Function, presentationMeta?: Function},
 *   execute: Function, timeoutMs?: number, isConcurrencySafe?: Function}} options
 * @returns {object} 工具定义
 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name === '') throw authorError('defineTool requires a non-empty name');
  if (typeof options.execute !== 'function') throw authorError(`defineTool(${options.name}): execute must be a function`);
  if (options.output === undefined || typeof options.output.render !== 'function') {
    throw authorError(`defineTool(${options.name}): output must declare { schema, render }`);
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw authorError(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }

  const tool = {
    name: options.name,
    description: options.description,
    parameters: parameterSchemaSpecToJsonSchema(options.parameters ?? {}),
    output: {
      schema: compileValue(options.output.schema, 'output.schema', false),
      render: (args, value) => options.output.render(args, value),
      ...(typeof options.output.presentationMeta === 'function'
        ? { presentationMeta: (args, value) => options.output.presentationMeta(args, value) }
        : {}),
    },
    execute: async (args, exec) => await options.execute(args, exec),
  };
  if (options.deferLoading === true) tool.deferLoading = true;
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
  if (typeof options.isConcurrencySafe === 'function') tool.isConcurrencySafe = (args) => options.isConcurrencySafe(args);
  return tool;
}
