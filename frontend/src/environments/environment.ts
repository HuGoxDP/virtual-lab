// path: src/environments/environment.ts

export const environment = {
  production: false,

  /**
   * URL to the remote catalog manifest JSON.
   *
   * In production, point this to your real hosting:
   * - GitHub Pages: https://username.github.io/scenarios/catalog.json
   * - S3 / GCS bucket: https://storage.example.com/catalog.json
   * - Your own API: https://api.example.com/v1/scenarios
*/
  catalogUrl: '/api/catalog',
};
