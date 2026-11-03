import { createApp } from 'vue';
import App from './App.vue';
import { createAccountSelection } from './account-selection';
import { createApiClientPlugin } from './api';
import { createAppI18n } from './i18n';
import { createAppRouter } from './router';
import { createAppTheme } from './theme';
import './assets/base.css';

// Composition root (spec §3): the application is assembled here so each
// UI stage has a single seam — router (166), string catalog (167), theme
// selection (168), the API client (169), and the account selection
// (170) are all plugged in. No component owns application wiring.
const router = createAppRouter();
const i18n = createAppI18n();
const theme = createAppTheme();
const api = createApiClientPlugin();
const accountSelection = createAccountSelection();

const app = createApp(App);
app.use(router);
app.use(i18n);
app.use(theme);
app.use(api);
app.use(accountSelection);

function mountApp(): void {
  app.mount('#app');
}

// Mount after the initial navigation settles — on success so a direct
// deep link paints the right view on the first render, and on failure
// too: a rejected initial navigation (a lazy-chunk fetch error, a
// throwing future guard) still mounts the shell, whose nav links
// recover, instead of leaving a blank page behind the rejection.
void router.isReady().then(mountApp, mountApp);
