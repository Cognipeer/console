// Guards the DS rule that keeps side-by-side form fields aligned: helper text
// renders UNDER the control, so `label → input` is a fixed two-row block and a
// `description` on one column can't push its input out of line with the
// neighbouring column that has none.
//
// Asserted against real rendered markup rather than the theme object, because
// the prop has to survive the TextInput → Input.Wrapper hand-off to matter.

import { describe, expect, it } from 'vitest';
import React, { type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as MantineCore from '@mantine/core';
import * as MantineDates from '@mantine/dates';

import { FIELD_CONTROLS, theme } from '@/theme/theme';

const registry = { ...MantineCore, ...MantineDates } as Record<string, unknown>;

type AnyComponent = ComponentType<Record<string, unknown>>;

const asComponent = (component: unknown) => component as AnyComponent;

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    React.createElement(
      MantineCore.MantineProvider,
      { theme, env: 'test' },
      node,
    ),
  );
}

function renderField(name: string, props: Record<string, unknown>) {
  const Component = registry[name];
  expect(
    Component,
    `${name} missing from @mantine/core + @mantine/dates`,
  ).toBeDefined();

  return render(React.createElement(asComponent(Component), props));
}

type Part = 'label' | 'description' | 'input' | 'error';

// The parts are identified by Mantine's own class names, which carry the
// shared selector (mantine-InputWrapper-description) alongside the
// component-specific one.
function partOrder(html: string): Part[] {
  const parts: { part: Part; at: number }[] = [
    { part: 'label', at: html.indexOf('InputWrapper-label') },
    { part: 'description', at: html.indexOf('InputWrapper-description') },
    { part: 'error', at: html.indexOf('InputWrapper-error') },
    { part: 'input', at: html.indexOf('Input-input') },
  ];

  return parts
    .filter(({ at }) => at !== -1)
    .sort((a, b) => a.at - b.at)
    .map(({ part }) => part);
}

const dataProps = (name: string) =>
  ['Select', 'MultiSelect', 'NativeSelect'].includes(name)
    ? { data: ['a', 'b'] }
    : null;

describe('form field part order', () => {
  it('renders helper text under the control for a described field', () => {
    const html = renderField('TextInput', {
      label: 'Model name',
      description: 'Shown to end users in the model picker',
      value: 'gpt-5',
      onChange: () => {},
    });

    expect(partOrder(html)).toEqual(['label', 'input', 'description']);
  });

  it('keeps the error under the control too, so nothing above it shifts', () => {
    const html = renderField('TextInput', {
      label: 'Model name',
      description: 'Shown to end users in the model picker',
      error: 'Name already in use',
      value: 'gpt-5',
      onChange: () => {},
    });

    expect(partOrder(html)).toEqual(['label', 'input', 'description', 'error']);
  });

  it('puts the control at the same offset whether or not there is helper text', () => {
    const described = renderField('TextInput', {
      label: 'Model name',
      description: 'Shown to end users in the model picker',
      value: 'gpt-5',
      onChange: () => {},
    });
    const bare = renderField('TextInput', {
      label: 'Display name',
      value: 'GPT-5',
      onChange: () => {},
    });

    // Same number of parts precede the control in both, which is what makes
    // the two columns of a form row line up.
    expect(partOrder(described).indexOf('input')).toBe(
      partOrder(bare).indexOf('input'),
    );
  });

  it('applies to every Input.Wrapper-based control, not just TextInput', () => {
    for (const name of FIELD_CONTROLS) {
      const html = renderField(name, {
        label: name,
        description: `${name} helper text`,
        ...dataProps(name),
      });

      expect(
        partOrder(html),
        `${name} renders helper text above its control`,
      ).toEqual(['label', 'input', 'description']);
    }
  });

  it('leaves *.Group wrappers alone — their description introduces the options', () => {
    const html = render(
      React.createElement(
        asComponent(MantineCore.Radio.Group),
        { label: 'Visibility', description: 'Who can call this endpoint' },
        React.createElement(asComponent(MantineCore.Radio), {
          value: 'public',
          label: 'Public',
        }),
      ),
    );

    expect(html.indexOf('InputWrapper-description')).toBeLessThan(
      html.indexOf('Radio-radio'),
    );
  });
});
