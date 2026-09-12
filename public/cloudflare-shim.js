// Cloudflare Shim for google.script.run
// Per-call runner: withSuccessHandler/withFailureHandler return a NEW runner
// so parallel calls (e.g. getAirportNotes + getFlightDashboardData) never
// overwrite each other's callbacks (fixes race that zeroed allDbFlights).
window.google = window.google || {};
window.google.script = window.google.script || {};

(function () {
  function makeRunner(successHandler, failureHandler) {
    return new Proxy({}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (callback) {
            return makeRunner(callback, failureHandler);
          };
        }
        if (prop === 'withFailureHandler') {
          return function (callback) {
            return makeRunner(successHandler, callback);
          };
        }

        // It's a backend function call (e.g. google.script.run.getFlights())
        // Capture handlers in closure — immune to parallel-call overwrite.
        var onSuccess = successHandler;
        var onFailure = failureHandler;
        return async function (...args) {
          try {
            console.log(`[Shim] Calling backend function: ${prop}`, args);
            const response = await fetch('/api/rpc', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ method: prop, args: args })
            });

            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();

            if (result && Object.prototype.hasOwnProperty.call(result, 'error') && result.error) {
              if (onFailure) {
                onFailure(result.error);
              } else {
                console.error(`[Shim] Backend error from ${prop}:`, result.error);
              }
            } else {
              if (onSuccess) {
                onSuccess(result.data);
              }
            }
          } catch (err) {
            if (onFailure) {
              onFailure(err);
            } else {
              console.error(`[Shim] Network/Shim error for ${prop}:`, err);
            }
          }
        };
      }
    });
  }

  window.google.script.run = makeRunner(null, null);
})();
