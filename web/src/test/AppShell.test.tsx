import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell, pageTitle } from '../components/AppShell';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-alice', username: 'alice', displayName: 'Alice', role: 'USER' },
    loading: false,
    logout: vi.fn(),
  }),
}));

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AppShell>
        <p>page body</p>
      </AppShell>
    </MemoryRouter>,
  );
}

describe('AppShell', () => {
  afterEach(() => {
    document.title = '';
  });

  it('shows the product name and the tagline in the header', () => {
    renderAt('/');
    expect(screen.getByRole('banner')).toHaveAttribute('aria-label', 'Uncle Bob');
    expect(screen.getByRole('link', { name: /Uncle Bob/ })).toBeInTheDocument();
    expect(screen.getByText("Bob's your uncle")).toBeInTheDocument();
  });

  it('titles the browser tab with the page name and the product name', () => {
    expect(pageTitle('/')).toBe('Dashboard \u2014 Uncle Bob');
    expect(pageTitle('/report-builder')).toBe('Report Builder \u2014 Uncle Bob');
    expect(pageTitle('/reports/abc123')).toBe('Report \u2014 Uncle Bob');
    expect(pageTitle('/nowhere')).toBe('Uncle Bob');

    renderAt('/schedules');
    expect(document.title).toBe('Schedules \u2014 Uncle Bob');
  });
});
