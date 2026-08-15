import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  detectLanguageMix,
  scoreToolSchemas,
} from '@/lib/services/workload/workloadSignals';

const flatTool = {
  name: 'get_weather',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

const openAiShapedTool = {
  type: 'function',
  function: {
    name: 'search',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'number' } },
    },
  },
};

const anthropicShapedTool = {
  name: 'lookup',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
  },
};

const nestedTool = {
  name: 'create_invoice',
  parameters: {
    type: 'object',
    properties: {
      customer: {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: { street: { type: 'string' }, city: { type: 'string' } },
          },
        },
      },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: { sku: { type: 'string' }, qty: { type: 'number' } },
        },
      },
    },
    required: ['customer', 'lines'],
  },
};

const unionTool = {
  name: 'pay',
  parameters: {
    type: 'object',
    properties: {
      method: { oneOf: [{ type: 'string' }, { type: 'object', properties: {} }] },
    },
  },
};

describe('scoreToolSchemas', () => {
  it('reads parameters from every traced tool shape', () => {
    const result = scoreToolSchemas([flatTool, openAiShapedTool, anthropicShapedTool]);
    expect(result.toolsAnalyzed).toBe(3);
    expect(result.maxParams).toBe(2);
    expect(result.band).toBe('simple');
  });

  it('rates flat single-parameter menus as simple', () => {
    const result = scoreToolSchemas([flatTool]);
    expect(result.maxDepth).toBe(1);
    expect(result.advancedSchemaTools).toBe(0);
    expect(result.score).toBeLessThan(0.3);
  });

  it('flags nesting and arrays of objects as complex', () => {
    const result = scoreToolSchemas([nestedTool]);
    expect(result.maxDepth).toBeGreaterThanOrEqual(3);
    expect(result.advancedSchemaTools).toBe(1);
    expect(result.band).toBe('complex');
  });

  it('counts union constructs as advanced', () => {
    expect(scoreToolSchemas([unionTool]).advancedSchemaTools).toBe(1);
  });

  it('counts a long enum as advanced', () => {
    const enumTool = {
      name: 'pick',
      parameters: {
        type: 'object',
        properties: {
          choice: { type: 'string', enum: Array.from({ length: 20 }, (_, i) => `v${i}`) },
        },
      },
    };
    expect(scoreToolSchemas([enumTool]).advancedSchemaTools).toBe(1);
  });

  it('skips unreadable definitions instead of scoring them simple', () => {
    const result = scoreToolSchemas([{ name: 'opaque' }, null, 'nonsense', flatTool]);
    expect(result.toolsAnalyzed).toBe(1);
  });

  it('returns the empty profile for no tools', () => {
    const result = scoreToolSchemas([]);
    expect(result.toolsAnalyzed).toBe(0);
    expect(result.score).toBe(0);
  });
});

describe('detectLanguage', () => {
  it('identifies Turkish', () => {
    expect(
      detectLanguage(
        'Bu bir test cümlesidir ve sistem için gerekli olan tüm bilgileri içerir, ancak daha fazla ayrıntı gerekebilir.',
      ),
    ).toBe('tr');
  });

  it('identifies English', () => {
    expect(
      detectLanguage(
        'This is the assistant that will help you with the task, and it should not be confused with the other one.',
      ),
    ).toBe('en');
  });

  it('identifies German and French', () => {
    expect(
      detectLanguage(
        'Das ist ein Test und der Benutzer wird nicht mit dem System sprechen, für eine bessere Antwort.',
      ),
    ).toBe('de');
    expect(
      detectLanguage(
        'Le client demande des informations sur les produits qui sont dans le catalogue avec une remise.',
      ),
    ).toBe('fr');
  });

  it('decides non-Latin scripts by codepoint', () => {
    expect(detectLanguage('これはテストです。よろしくお願いします。')).toBe('ja');
    expect(detectLanguage('это тестовое сообщение для системы проверки')).toBe('ru');
  });

  it('abstains on samples that are too short or too ambiguous', () => {
    expect(detectLanguage('ok')).toBeUndefined();
    expect(detectLanguage('')).toBeUndefined();
    expect(detectLanguage('SELECT id FROM users WHERE tenant = 42 ORDER BY id DESC')).toBeUndefined();
  });
});

describe('detectLanguageMix', () => {
  it('reports the dominant language and the non-English share', () => {
    const mix = detectLanguageMix([
      'Merhaba, bu siparişin durumu nedir ve ne zaman teslim edilecek acaba?',
      'Bu konuda daha fazla bilgi almak için müşteri hizmetleri ile görüşmek gerekir.',
      'This is the only English sentence in the sample, and it should not win the vote.',
    ]);
    expect(mix.primary).toBe('tr');
    expect(mix.classified).toBe(3);
    expect(mix.nonEnglishShare).toBeCloseTo(0.67, 1);
  });

  it('excludes unclassifiable samples instead of counting them as English', () => {
    const mix = detectLanguageMix(['ok', '', '12345']);
    expect(mix.primary).toBe('unknown');
    expect(mix.classified).toBe(0);
    expect(mix.nonEnglishShare).toBe(0);
    expect(mix.samples).toBe(3);
  });
});
