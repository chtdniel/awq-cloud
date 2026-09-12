// Cloudflare Shim for google.script.run
window.google = window.google || {};
window.google.script = window.google.script || {};

window.google.script.run = new Proxy({}, {
  get: function(target, prop) {
    if (prop === 'withSuccessHandler') {
      return function(callback) {
        target._successHandler = callback;
        return window.google.script.run;
      };
    }
    if (prop === 'withFailureHandler') {
      return function(callback) {
        target._failureHandler = callback;
        return window.google.script.run;
      };
    }
    
    // It's a backend function call (e.g. google.script.run.getFlights())
    return async function(...args) {
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
        
        if (result.error) {
          if (target._failureHandler) {
            target._failureHandler(result.error);
          } else {
            console.error(`[Shim] Backend error from ${prop}:`, result.error);
          }
        } else {
          if (target._successHandler) {
            target._successHandler(result.data);
          }
        }
      } catch (err) {
        if (target._failureHandler) {
          target._failureHandler(err);
        } else {
          console.error(`[Shim] Network/Shim error for ${prop}:`, err);
        }
      } finally {
        // Reset handlers for the next call
        target._successHandler = null;
        target._failureHandler = null;
      }
    };
  }
});
