// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ImageDiff } from '../src/components/diff/ImageDiff.tsx';

const image = { mime: 'image/png' as const, base64: 'aGVsbG8=', byteLength: 5 };
afterEach(cleanup);

it('shows both image versions and supports overlay and difference', () => {
  render(<ImageDiff images={{ before: image, after: image }} />);
  expect(screen.getByAltText('Before').getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
  expect(screen.getByAltText('After')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'overlay' } });
  fireEvent.change(screen.getByRole('slider'), { target: { value: '25' } });
  expect(screen.getByAltText('After').style.opacity).toBe('0.25');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'difference' } });
  expect(screen.getByAltText('After').style.mixBlendMode).toBe('difference');
});

it('explains a missing side and disables comparison modes for new images', () => {
  render(<ImageDiff images={{ before: null, after: image }} />);
  expect(screen.getByText('No previous image')).toBeTruthy();
  expect((screen.getByRole('option', { name: 'Overlay' }) as HTMLOptionElement).disabled).toBe(
    true,
  );
});

it('reports decoding errors and oversized image warnings', () => {
  render(<ImageDiff images={{ before: image, after: null, warning: 'Image too large' }} />);
  fireEvent.error(screen.getByAltText('Before'));
  expect(screen.getByText('This image could not be decoded.')).toBeTruthy();
  expect(screen.getByText('Image too large')).toBeTruthy();
});
