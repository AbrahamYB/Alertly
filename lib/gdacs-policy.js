export function isPublicGdacsEvent({ eventType, providerActive, alertLevel, burnedArea, affectedPopulation }) {
  if (!providerActive) return false;
  if (eventType !== "wf") return true;
  if (alertLevel === "orange" || alertLevel === "red") return true;
  return burnedArea >= 10000 && affectedPopulation >= 10000;
}
