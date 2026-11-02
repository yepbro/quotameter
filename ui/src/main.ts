import { createApp } from 'vue';
import App from './App.vue';
import { createAppI18n } from './i18n';
import { createAppRouter } from './router';
import './assets/base.css';

// Composition root (spec §3): the application is assembled here so each
// UI stage has a single seam — theme selection plugs in with 168. No
// component owns application wiring.
const router = createAppRouter();
const i18n = createAppI18n();

const app = createApp(App);
app.use(router);
app.use(i18n);

function mountApp(): void {
  app.mount('#app');
}

// Mount after the initial navigation settles — on success so a direct
// deep link paints the right view on the first render, and on failure
// too: a rejected initial navigation (a lazy-chunk fetch error, a
// throwing future guard) still mounts the shell, whose nav links
// recover, instead of leaving a blank page behind the rejection.
void router.isReady().then(mountApp, mountApp);
