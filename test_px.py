import asyncio
import os
from project_x_py import ProjectX
from dotenv import load_dotenv

load_dotenv('/Users/tbrook/Desktop/AI Trader Prop/.env')

async def main():
    try:
        # project-x-py might expect different env vars. Let's look at its source or just pass them explicitly.
        # But we can try just creating the client directly if possible.
        print("Testing with username:", os.environ.get("TOPSTEPX_USERNAME"))
        # Let's try init with explicitly passed credentials if possible, otherwise rely on env mapping
        # Actually ProjectX.from_env() expects specific env vars.
        # Let's just try:
        client = ProjectX(
            username=os.environ.get("TOPSTEPX_USERNAME"),
            api_key=os.environ.get("TOPSTEPX_API_KEY"), # Wait, does it use api_key or api_key? The docs said api_key
        )
        await client.authenticate()
        print("Auth success!")
        print(client.account_info)
    except Exception as e:
        print(f"Failed: {e}")

asyncio.run(main())
