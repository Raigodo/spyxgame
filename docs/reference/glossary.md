# Glossary

Read when a term in the code or docs is unclear.

| Term        | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| Peer        | One browser connection in a room. Has a fresh `PeerId` per join                    |
| Player      | Durable identity (`PlayerId`) behind a peer; survives refresh                      |
| Host        | The peer that owns shared state and relays messages                                |
| Guest       | Any non-host peer                                                                  |
| Star        | Topology where guests connect only to the host                                     |
| Link        | The WebRTC data channel between two peers (`connecting`, `active`, `reconnecting`) |
| Signaling   | Firestore documents used to set up links and elect a host                          |
| Election    | Choosing a new host after the old one died                                         |
| Candidate   | A guest taking part in an election                                                 |
| Reclaim     | A refreshed host taking its seat back with a new peer id                           |
| Hand-off    | The host giving the seat to a chosen peer                                          |
| Channel     | A named replicated unit on the bus (state, event or private)                       |
| Epoch, rev  | Version of a state channel: epoch per host term, rev per change                    |
| Command     | The only way to change replicated state                                            |
| Reducer     | Pure `(state, payload) -> state`                                                   |
| Slot        | The running game inside `GameState`                                                |
| Round       | Counter that increases when a game ends                                            |
| Ghost       | Roster entry whose peer left; kept briefly for rejoin                              |
| Store, Cell | Observable value (read side, owner side)                                           |
| Scope       | Owner of cleanups; disposed last-in-first-out                                      |
| Port        | Injected interface to the outside world                                            |
| Harness     | Test setup that runs real code on fakes                                            |
