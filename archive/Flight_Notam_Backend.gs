/** Flight sidebar adapter backed by the FIR impact engine. */
function flightBuildNotamIndex_(analyses) {
  const byRowId = {};
  (analyses || []).forEach(analysis => {
    const rowId = Number(analysis && analysis._rowId);
    if (!rowId) return;
    const items = (analysis.analysis || [])
      .filter(item => item && item.isDirectImpact === true && item.status === 'ACTIVE')
      .map(item => ({
        notamNum: item.number || item.id || '',
        airport: item.location || '',
        priority: item.risk || 'LOW',
        status: item.status,
        matchReason: item.matchReason || '',
        rawText: item.text || ''
      }));
    const highestPriority = items.some(item => item.priority === 'HIGH') ? 'HIGH'
      : items.some(item => item.priority === 'MEDIUM') ? 'MEDIUM'
      : items.length ? 'LOW' : '';
    byRowId[rowId] = {
      status: items.length ? 'ACTIVE' : 'NONE',
      count: items.length,
      highestPriority,
      items
    };
  });
  return byRowId;
}

function analyzeFlightBoardNotams(rowIds) {
  const ids = (Array.isArray(rowIds) ? rowIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { byRowId: {}, timestamp: new Date().toISOString() };
  const analyses = analyzeFlightList(ids);
  if (!Array.isArray(analyses)) return analyses && analyses.error ? analyses : { error: 'FIR analysis returned an invalid result.' };
  return {
    byRowId: flightBuildNotamIndex_(analyses),
    timestamp: new Date().toISOString()
  };
}

function flightNotamAdapterSelfCheck() {
  const result = flightBuildNotamIndex_([{
    _rowId: 42,
    analysis: [
      { number: 'A0001/26', risk: 'HIGH', status: 'ACTIVE', isDirectImpact: true },
      { number: 'A0002/26', risk: 'HIGH', status: 'ACTIVE', isDirectImpact: false },
      { number: 'A0003/26', risk: 'MEDIUM', status: 'CANCELLED', isDirectImpact: true }
    ]
  }]);
  if (!result[42] || result[42].count !== 1 || result[42].items[0].notamNum !== 'A0001/26') {
    throw new Error('Flight NOTAM adapter must return only active direct impacts per row ID.');
  }
  return { ok: true };
}

function smokeTestFlightBoardNotams() {
  const data = getFlightDashboardData(false);
  const ids = (data.flights || []).slice(0, 10).map(flight => Number(flight.rowIdx));
  const result = analyzeFlightBoardNotams(ids);
  console.log(JSON.stringify(result, null, 2));
  return result;
}
