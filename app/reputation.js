// Local reputation ledger — tracks compute donated and consumed
// Score = donated - consumed. Higher score = more likely to get workers.
import fs from 'fs'
import { resolve } from 'path'

const LEDGER_PATH = resolve('./reputation.json')

export function loadReputation () {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'))
  } catch {
    return { donated: 0, consumed: 0 }
  }
}

export function saveReputation (rep) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(rep, null, 2))
}

export function getScore (rep) {
  return rep.donated - rep.consumed
}

export function addDonated (n = 1) {
  const rep = loadReputation()
  rep.donated += n
  saveReputation(rep)
  return rep
}

export function addConsumed (n = 1) {
  const rep = loadReputation()
  rep.consumed += n
  saveReputation(rep)
  return rep
}
