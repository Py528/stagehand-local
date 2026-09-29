import asyncio
import os
import subprocess
from pathlib import Path
import httpx
import psutil

from playwright.async_api import Browser as PlaywrightBrowser
from playwright.async_api import (
    BrowserContext as PlaywrightBrowserContext,
    Playwright,
    async_playwright,
)
from browser_use.browser.browser import Browser, IN_DOCKER
from browser_use.browser.context import BrowserContext, BrowserContextConfig
import logging

from browser_use.browser.chrome import (
    CHROME_ARGS,
    CHROME_DETERMINISTIC_RENDERING_ARGS,
    CHROME_DISABLE_SECURITY_ARGS,
    CHROME_DOCKER_ARGS,
    CHROME_HEADLESS_ARGS,
)
from browser_use.browser.utils.screen_resolution import get_screen_resolution, get_window_adjustments
from browser_use.utils import time_execution_async
import socket

from .custom_context import CustomBrowserContext

logger = logging.getLogger(__name__)


class CustomBrowser(Browser):

    async def new_context(self, config: BrowserContextConfig | None = None) -> CustomBrowserContext:
        """Create a browser context"""
        browser_config = self.config.model_dump() if self.config else {}
        context_config = config.model_dump() if config else {}
        merged_config = {**browser_config, **context_config}
        return CustomBrowserContext(config=BrowserContextConfig(**merged_config), browser=self)

    async def _setup_builtin_browser(self, playwright: Playwright) -> PlaywrightBrowser:
        """Sets up and returns a Playwright Browser instance with anti-detection measures."""
        assert self.config.browser_binary_path is None, 'browser_binary_path should be None if trying to use the builtin browsers'

        if (
                not self.config.headless
                and hasattr(self.config, 'new_context_config')
                and hasattr(self.config.new_context_config, 'window_width')
                and hasattr(self.config.new_context_config, 'window_height')
        ):
            screen_size = {
                'width': self.config.new_context_config.window_width,
                'height': self.config.new_context_config.window_height,
            }
            offset_x, offset_y = get_window_adjustments()
        elif self.config.headless:
            screen_size = {'width': 1920, 'height': 1080}
            offset_x, offset_y = 0, 0
        else:
            screen_size = get_screen_resolution()
            offset_x, offset_y = get_window_adjustments()

        port = self.config.chrome_remote_debugging_port or 9222
        chrome_args = {
            f'--remote-debugging-port={port}',
            *CHROME_ARGS,
            *(CHROME_DOCKER_ARGS if IN_DOCKER else []),
            *(CHROME_HEADLESS_ARGS if self.config.headless else []),
            *(CHROME_DISABLE_SECURITY_ARGS if self.config.disable_security else []),
            *(CHROME_DETERMINISTIC_RENDERING_ARGS if self.config.deterministic_rendering else []),
            f'--window-position={offset_x},{offset_y}',
            f'--window-size={screen_size["width"]},{screen_size["height"]}',
            *self.config.extra_browser_args,
        }

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) == 0:
                chrome_args.remove(f'--remote-debugging-port={port}')

        browser_class = getattr(playwright, self.config.browser_class)
        args = {
            'chromium': list(chrome_args),
            'firefox': [
                *{
                    '-no-remote',
                    *self.config.extra_browser_args,
                }
            ],
            'webkit': [
                *{
                    '--no-startup-window',
                    *self.config.extra_browser_args,
                }
            ],
        }

        browser = await browser_class.launch(
            channel='chromium',
            headless=self.config.headless,
            args=args[self.config.browser_class],
            proxy=self.config.proxy.model_dump() if self.config.proxy else None,
            handle_sigterm=False,
            handle_sigint=False,
        )
        return browser

    async def _setup_user_provided_browser(self, playwright: Playwright) -> PlaywrightBrowser:
        """Sets up and returns a Playwright Browser instance with user sessions."""
        if not self.config.browser_binary_path:
            raise ValueError('A browser_binary_path is required')

        assert self.config.browser_class == 'chromium', (
            'browser_binary_path only supports chromium browsers'
        )

        port = self.config.chrome_remote_debugging_port or 9222
        browser_class = getattr(playwright, self.config.browser_class)

        # 1. Check if browser is already running on the debugging port
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(f'http://127.0.0.1:{port}/json/version', timeout=1.5)
                if response.status_code == 200:
                    logger.info(f'🔌 Reusing existing browser found running on http://127.0.0.1:{port}')
                    return await browser_class.connect_over_cdp(
                        endpoint_url=f'http://127.0.0.1:{port}',
                        timeout=20000,
                    )
        except Exception:
            logger.debug(f'🌎 No existing browser found on port {port}, starting new instance...')

        # 2. Extract user data dir if provided
        provided_user_data_dir = [arg for arg in self.config.extra_browser_args if '--user-data-dir=' in arg]
        extra_args_filtered = [arg for arg in self.config.extra_browser_args if not arg.startswith('--user-data-dir=')]

        user_data_dir = None
        if provided_user_data_dir:
            user_data_dir = Path(provided_user_data_dir[0].split('=', 1)[-1])

        # 3. Build Chrome launch args
        chrome_launch_args = [
            f'--remote-debugging-port={port}',
            *( [f'--user-data-dir={user_data_dir.resolve()}'] if user_data_dir else [] ),
            *CHROME_ARGS,
            *(CHROME_DOCKER_ARGS if IN_DOCKER else []),
            *(CHROME_HEADLESS_ARGS if self.config.headless else []),
            *(CHROME_DISABLE_SECURITY_ARGS if self.config.disable_security else []),
            *(CHROME_DETERMINISTIC_RENDERING_ARGS if self.config.deterministic_rendering else []),
            *extra_args_filtered,
        ]
        # Remove duplicates preserving order
        seen = set()
        deduped_args = []
        for a in chrome_launch_args:
            if a not in seen:
                seen.add(a)
                deduped_args.append(a)

        chrome_sub_process = await asyncio.create_subprocess_exec(
            self.config.browser_binary_path,
            *deduped_args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
        self._chrome_subprocess = psutil.Process(chrome_sub_process.pid)

        # 4. Wait for browser to listen on 127.0.0.1
        connected = False
        for _ in range(15):
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(f'http://127.0.0.1:{port}/json/version', timeout=1.0)
                    if response.status_code == 200:
                        connected = True
                        break
            except Exception:
                pass
            await asyncio.sleep(0.5)

        # 5. Connect using 127.0.0.1
        return await browser_class.connect_over_cdp(
            endpoint_url=f'http://127.0.0.1:{port}',
            timeout=20000,
        )
