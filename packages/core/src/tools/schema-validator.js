// 零依赖 JSON Schema 校验器（v1 子集）
// 支持的 type：string / number / integer / boolean / object / array
// 支持的约束：
//   object: properties / required / additionalProperties
//   string: minLength / maxLength / pattern
//   number/integer: minimum / maximum
//   array: items / minItems / maxItems
//   通用：enum / const
// 不支持：$ref / $defs / oneOf / anyOf / allOf / not / if-then-else
//
// 返回 { ok: boolean, errors: string[] }，错误路径用 JSON Pointer 格式。

/**
 * 校验 value 是否符合 schema。
 * @param {any} value
 * @param {object} schema
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateAgainstSchema(value, schema) {
  const errors = [];
  if (schema && typeof schema === 'object') {
    walk(value, schema, '', errors);
  }
  return { ok: errors.length === 0, errors };
}

function walk(value, schema, ptr, errors) {
  // const 优先级最高（比 type 更严格）
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (!deepEqual(value, schema.const)) {
      errors.push(`${ptr || '/'} 必须等于 ${JSON.stringify(schema.const)}`);
      return;
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => deepEqual(value, e))) {
      errors.push(`${ptr || '/'} 必须是枚举值 [${schema.enum.map(JSON.stringify).join(', ')}] 之一`);
      // enum 不匹配就不再往下校验 type
      return;
    }
  }

  const types = normalizeTypes(schema.type);
  if (!types || types.length === 0) {
    // 没有指定 type：不做类型检查（允许 any）
    // 但仍要跑 enum / const 之外的子约束
  } else {
    let matched = false;
    for (const t of types) {
      if (checkType(value, t)) { matched = true; break; }
    }
    if (!matched) {
      errors.push(`${ptr || '/'} 必须是 ${types.join(' | ')}，实际是 ${describeType(value)}`);
      return; // 类型不匹配，子约束没有意义
    }
  }

  // 子约束：只在类型匹配时检查
  if (types == null || types.includes('string')) {
    checkString(value, schema, ptr, errors);
  }
  if (types == null || types.includes('number') || types.includes('integer')) {
    checkNumber(value, schema, ptr, errors);
  }
  if (types == null || types.includes('object')) {
    checkObject(value, schema, ptr, errors);
  }
  if (types == null || types.includes('array')) {
    checkArray(value, schema, ptr, errors);
  }
}

function normalizeTypes(t) {
  if (t == null) return null;
  if (Array.isArray(t)) return t;
  return [t];
}

function checkType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return true; // 未知类型放行
  }
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkString(value, schema, ptr, errors) {
  if (typeof value !== 'string') return;
  if (schema.minLength != null && value.length < schema.minLength) {
    errors.push(`${ptr || '/'} 字符串长度 ${value.length} < minLength ${schema.minLength}`);
  }
  if (schema.maxLength != null && value.length > schema.maxLength) {
    errors.push(`${ptr || '/'} 字符串长度 ${value.length} > maxLength ${schema.maxLength}`);
  }
  if (typeof schema.pattern === 'string') {
    try {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(`${ptr || '/'} 不匹配 pattern ${schema.pattern}`);
      }
    } catch {
      // 非法正则，跳过
    }
  }
}

function checkNumber(value, schema, ptr, errors) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  if (schema.minimum != null && value < schema.minimum) {
    errors.push(`${ptr || '/'} ${value} < minimum ${schema.minimum}`);
  }
  if (schema.maximum != null && value > schema.maximum) {
    errors.push(`${ptr || '/'} ${value} > maximum ${schema.maximum}`);
  }
}

function checkObject(value, schema, ptr, errors) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;

  // required
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${ptr || '/'} 缺少必填属性 "${key}"`);
      }
    }
  }

  // properties
  const props = schema.properties;
  if (props && typeof props === 'object') {
    for (const [key, subschema] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && subschema && typeof subschema === 'object') {
        walk(value[key], subschema, `${ptr}/${key}`, errors);
      }
    }
  }

  // additionalProperties
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(props || {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        errors.push(`${ptr || '/'} 不允许额外属性 "${key}"（additionalProperties=false）`);
      }
    }
  } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    const allowed = new Set(Object.keys(props || {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        walk(value[key], schema.additionalProperties, `${ptr}/${key}`, errors);
      }
    }
  }
}

function checkArray(value, schema, ptr, errors) {
  if (!Array.isArray(value)) return;
  if (schema.minItems != null && value.length < schema.minItems) {
    errors.push(`${ptr || '/'} 数组长度 ${value.length} < minItems ${schema.minItems}`);
  }
  if (schema.maxItems != null && value.length > schema.maxItems) {
    errors.push(`${ptr || '/'} 数组长度 ${value.length} > maxItems ${schema.maxItems}`);
  }
  if (schema.items && typeof schema.items === 'object') {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], schema.items, `${ptr}/${i}`, errors);
    }
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}
