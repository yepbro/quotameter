import { createApp } from 'vue';
import App from './App.vue';
import { createAppRouter } from './router';
import './assets/base.css';

// Composition root (spec §3): the application is assembled here so each
// UI stage has a single seam — the vue-i18n English catalog plugs in with
// 167, theme selection with 168. No component owns application wiring.
const router = createAppRouter();

const app = createApp(App);
app.use(router);

function mountApp(): void {
  app.mount('#app');
}

// Mount after the initial navigation settles — on success so a direct
// deep link paints the right view on the first render, and on failure
// too: a rejected initial navigation (a lazy-chunk fetch error, a
// throwing future guard) still mounts the shell, whose nav links
// recover, instead of leaving a blank page behind the rejection.
void router.isReady().then(mountApp, mountApp);
