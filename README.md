# BridgeRemit — Flask + Solidity Remittance DApp

Current backend: Python Flask / Web3.py, served by Gunicorn on Render. The English frontend, four Sepolia contracts and PostgreSQL database are retained.

- Website: https://bridge-remit.onrender.com/
- Setup, migration and submission files: [docs/FLASK_MIGRATION.md](docs/FLASK_MIGRATION.md)
- Python entry points: app.py and wsgi.py; dependencies: requirements.txt.
- Contract source: contracts/BridgeRemit.sol; standalone ABIs: abi/*.json.
- Node.js is used only for contract compilation and local-chain test tooling. server/ and tests/api.test.mjs are historical references, not the deployed backend.

## Run

Create a Python virtual environment and install requirements.txt. Install the Node tool dependencies and run pnpm build once to produce the contract artifacts and local browser library. Set RPC_URL to your Sepolia endpoint and APP_ORIGIN to http://localhost:3000, then run python app.py.

## Verify

Run pnpm test for the 16 Solidity cases. Start node tests/flask-fixture.mjs in a separate terminal, then run python -m unittest discover -s tests -p test_flask.py -v for 9 Flask integration cases. Restart the fixture before another complete test run. Generated test keys in data/ are excluded from publication.

The public deployment configuration and seven successful Sepolia deployment/configuration transactions were verified. Local transfer/claim tests are not proof of a real multi-wallet Sepolia demonstration. Record the actual demonstration and supply the YouTube link or present live as instructed.

Only test ETH and dUSD are used. FX, identity review and payout attestations are simulated; there is no real fiat conversion or bank payout.
