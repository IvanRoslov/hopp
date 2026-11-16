import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Frame } from './Frame';

describe('Frame', () => {
  it('shows left and right zones, middle only when given', () => {
    const { rerender } = render(<Frame left={<span>L</span>} middle={null} right={<span>R</span>} />);
    expect(screen.getByTestId('zone-left').textContent).toBe('L');
    expect(screen.getByTestId('zone-right').textContent).toBe('R');
    expect(screen.queryByTestId('zone-middle')).toBeNull();
    rerender(<Frame left={<span>L</span>} middle={<span>M</span>} right={<span>R</span>} />);
    expect(screen.getByTestId('zone-middle').textContent).toBe('M');
  });
});
