import { createApp } from 'vue';
import App from './App.vue';
import './assets/base.css';

// Composition root (spec §3): the application is assembled here so each
// later UI stage has a single seam — Vue Router and the shell layout plug
// in with task 166, the vue-i18n English catalog with 167, theme
// selection with 168. No component owns application wiring.
const app = createApp(App);

app.mount('#app');
