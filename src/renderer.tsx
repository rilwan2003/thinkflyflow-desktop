import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SearchPalette } from './SearchPalette';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('Root element missing from index.html');

// One bundle serves both windows. The hash decides which surface renders, so
// the search palette is not a second build to keep in step.
const isSearchWindow = window.location.hash.replace('#', '') === 'search';

if (isSearchWindow) document.body.classList.add('is-search-window');

createRoot(el).render(
  <React.StrictMode>{isSearchWindow ? <SearchPalette /> : <App />}</React.StrictMode>,
);
