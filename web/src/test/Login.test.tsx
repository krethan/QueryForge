import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../api/client';
import { AuthProvider } from '../auth/AuthContext';
import { LoginPage } from '../pages/LoginPage';

function renderAt(url = '/login') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.spyOn(api, 'me').mockRejectedValue(new Error('no session'));
  });
  afterEach(() => vi.restoreAllMocks());

  it('offers SSO and the directory switch when configured', async () => {
    vi.spyOn(api, 'providers').mockResolvedValue({
      local: true,
      oidc: { label: 'Contoso SSO', startUrl: '/api/auth/oidc/start' },
      ldap: { label: 'Company directory' },
    });
    renderAt();
    const sso = await screen.findByRole('link', { name: /Sign in with Contoso SSO/ });
    expect(sso).toHaveAttribute('href', '/api/auth/oidc/start');
    expect(screen.getByRole('tab', { name: 'Company directory' })).toBeInTheDocument();
  });

  it('hides the password form when only SSO is enabled and shows SSO errors', async () => {
    vi.spyOn(api, 'providers').mockResolvedValue({
      local: false,
      oidc: { label: 'Contoso SSO', startUrl: '/api/auth/oidc/start' },
      ldap: null,
    });
    renderAt('/login?sso_error=SSO_STATE_MISMATCH');
    expect(await screen.findByRole('link', { name: /Contoso SSO/ })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Password/)).toBeNull();
    expect(screen.getByText('Single sign-on failed.')).toBeInTheDocument();
  });
});
