/**
 * The "who / what does this limit point at" field as it first renders for a
 * resource or provider limit (server render: no effects, so no search has run).
 * What matters here is WHICH control a service gets: a search box that says what
 * it searches, never the plain id field this used to be, and a note when a
 * provider limit could never apply.
 */
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '@/lib/i18n';
import { theme } from '@/theme/theme';
import { ScopeIdSelector } from '@/components/quota/ScopeIdSelector';
import type { QuotaDomain, QuotaScope } from '@/lib/quota/types';

type Loose = ComponentType<{ locale?: string; children?: ReactNode; theme?: unknown; env?: string }>;
const I18n = I18nProvider as unknown as Loose;
const Mantine = MantineProvider as unknown as Loose;

interface Props {
  scope: QuotaScope;
  domain?: QuotaDomain;
  value?: string;
  valueMissing?: boolean;
  resourceOptions?: Array<{ value: string; label: string }>;
}

function render(props: Props, locale = 'en'): string {
  return renderToStaticMarkup(
    createElement(
      Mantine,
      { theme, env: 'test' },
      createElement(I18n, { locale }, createElement(ScopeIdSelector, { onChange: () => {}, ...props })),
    ),
  );
}

const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
const hasSearchBox = (html: string, placeholder: string) => html.includes(`placeholder="${placeholder}"`);
const OLD_TEXT_FIELD = 'User ID, Token ID, Model Key, etc.';

describe('a resource limit', () => {
  it.each<[QuotaDomain, string]>([
    ['llm', 'Search models by name or key'],
    ['embedding', 'Search models by name or key'],
    ['image', 'Search models by name or key'],
    ['stt', 'Search models by name or key'],
    ['tts', 'Search models by name or key'],
    ['ocr', 'Search models by name or key'],
    ['decision', 'Search models by name or key'],
    ['moderation', 'Search models by name or key'],
    ['vector', 'Search vector indexes by name or key'],
    ['file', 'Search file buckets by name or key'],
    ['tracing', 'Search agents or type a name'],
    ['global', 'Search models, indexes and buckets'],
  ])('in the %s service is a search box that says what it searches', (domain, placeholder) => {
    const html = render({ scope: 'resource', domain });
    expect(hasSearchBox(html, placeholder), html).toBe(true);
    expect(attr(html, 'aria-label')).toBe(placeholder);
    expect(html).not.toContain(OLD_TEXT_FIELD);
    // A searchable dropdown, not a bare text field.
    expect(html).toContain('aria-haspopup="listbox"');
  });

  it('is the agent picker in the agent service, as before', () => {
    const html = render({ scope: 'resource', domain: 'agent' });
    expect(hasSearchBox(html, 'Search agents')).toBe(true);
    expect(html).not.toContain('by name or key');
  });

  it('with no service given is searched like a global limit', () => {
    expect(hasSearchBox(render({ scope: 'resource' }), 'Search models, indexes and buckets')).toBe(true);
  });

  it('keeps a fixed list for a caller that brings its own', () => {
    const html = render({ scope: 'resource', domain: 'llm', resourceOptions: [{ value: 'gpt-4o', label: 'GPT-4o' }] });
    expect(hasSearchBox(html, 'Select resource')).toBe(true);
    expect(html).not.toContain('by name or key');
  });

  it('shows the saved value at once, before any search has answered', () => {
    const html = render({ scope: 'resource', domain: 'llm', value: 'gpt-4o' });
    expect(html).toContain('value="gpt-4o"');
  });

  it('speaks Turkish when the console does', () => {
    expect(hasSearchBox(render({ scope: 'resource', domain: 'llm' }, 'tr'), 'Modelleri ada veya anahtara göre ara')).toBe(true);
    expect(hasSearchBox(render({ scope: 'resource', domain: 'vector' }, 'tr'), 'Vektör indekslerini ada veya anahtara göre ara')).toBe(true);
    expect(hasSearchBox(render({ scope: 'resource', domain: 'file' }, 'tr'), 'Dosya kovalarını ada veya anahtara göre ara')).toBe(true);
  });
});

describe('a provider limit', () => {
  it.each<QuotaDomain>(['vector', 'file', 'global'])('in the %s service is a provider search box, with nothing to warn about', (domain) => {
    const html = render({ scope: 'provider', domain });
    expect(hasSearchBox(html, 'Search providers by name or key'), html).toBe(true);
    expect(html).not.toContain(OLD_TEXT_FIELD);
    expect(html).not.toContain('never applies');
  });

  it.each<[QuotaDomain, string]>([
    ['llm', 'LLM / Chat'],
    ['embedding', 'Embeddings'],
    ['tracing', 'Agent Observability'],
    ['agent', 'Agent runs'],
  ])('in the %s service says it could never apply, since those calls report no provider', (domain, serviceName) => {
    const html = render({ scope: 'provider', domain });
    expect(hasSearchBox(html, 'Search providers by name or key')).toBe(true);
    expect(html).toContain(`${serviceName} calls do not report a provider, so a limit on a provider never applies to them.`);
    expect(html).toContain('Use provider limits for vector or file calls.');
  });

  it('says so in Turkish too', () => {
    const html = render({ scope: 'provider', domain: 'llm' }, 'tr');
    expect(html).toContain('çağrıları bir sağlayıcı bildirmez');
    expect(hasSearchBox(html, 'Sağlayıcıları ada veya anahtara göre ara')).toBe(true);
  });
});

describe('a saved target that is gone', () => {
  it.each<[QuotaScope, QuotaDomain, string]>([
    ['user', 'llm', 'This person was not found. The limit keeps their id but applies to nobody.'],
    ['group', 'llm', 'This group was not found. The limit keeps its id but applies to nobody.'],
    ['token', 'llm', 'This API token was not found. The limit keeps its id but applies to nothing.'],
    ['resource', 'agent', 'This agent was not found. The limit keeps its key but applies to no run.'],
  ])('keeps the id and says so for a %s', (scope, domain, note) => {
    const html = render({ scope, domain, value: 'gone-1', valueMissing: true });
    expect(html).toContain(note);
    expect(html).toContain('value="gone-1"');
  });

  it('says nothing for one that exists, or when nothing is chosen', () => {
    expect(render({ scope: 'user', domain: 'llm', value: 'u1', valueMissing: false })).not.toContain('was not found');
    expect(render({ scope: 'user', domain: 'llm', valueMissing: true })).not.toContain('was not found');
  });

  it('is said in Turkish too', () => {
    expect(render({ scope: 'user', domain: 'llm', value: 'u1', valueMissing: true }, 'tr')).toContain('Bu kişi bulunamadı.');
  });

  it('leaves a model or provider to its own picker, which looks the value up itself', () => {
    expect(render({ scope: 'resource', domain: 'llm', value: 'gpt-4o', valueMissing: true })).not.toContain('was not found');
  });
});

describe('the other kinds of target', () => {
  it('need no field for the tenant itself', () => {
    // (Mantine's own <style> tag is all that is left.)
    expect(render({ scope: 'tenant', domain: 'llm' }).replace(/<style[\s\S]*?<\/style>/g, '')).toBe('');
  });

  it.each<[QuotaScope, string]>([
    ['user', 'Select user'],
    ['group', 'Search groups'],
    ['token', 'Select API token'],
  ])('a %s keeps its own picker', (scope, placeholder) => {
    expect(hasSearchBox(render({ scope, domain: 'llm' }), placeholder)).toBe(true);
  });
});
