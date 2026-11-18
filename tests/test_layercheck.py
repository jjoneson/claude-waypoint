"""Tests for skills/map/layercheck.py: small source trees made in a temporary folder, checked against a map.

    python3 -m unittest discover -s tests -p 'test_*.py'
"""
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "skills" / "map" / "layercheck.py"


def run(top: Path, *args: str) -> tuple[int, str]:
    done = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=top, capture_output=True, text=True)
    return done.returncode, done.stdout + done.stderr


class Tree:
    """A repository in a temporary folder: files written from a dict, and the map at docs/architecture.md."""

    def __init__(self, files: dict[str, str], map_text: str | None = None):
        self._tmp = tempfile.TemporaryDirectory()
        self.top = Path(self._tmp.name)
        for path, text in files.items():
            self.write(path, text)
        if map_text is not None:
            self.write("docs/architecture.md", map_text)

    def write(self, path: str, text: str) -> None:
        file = self.top / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(textwrap.dedent(text))

    def close(self) -> None:
        self._tmp.cleanup()


TS_FILES = {
    "src/main.ts": "import { start } from './billing/ledger';\nstart();\n",
    "src/orders/cart.ts": """
        import { rate } from '../billing/rates';
        import type { Money } from '../billing/money';
        // import { ledger } from '../billing/ledger';   a comment is not an import
        const text = "import { nope } from '../billing/ledger'";
        export const cart = [rate, text] as unknown as Money[];
    """,
    "src/billing/rates.ts": "export const rate = 1;\n",
    "src/billing/money.ts": "export type Money = { name: string };\n",
    "src/billing/ledger.ts": """
        import { cart } from '../orders/cart';
        export { rate } from './rates';
        export const start = () => cart;
        export const later = () => import('../ui/page');
        export type Page = typeof import('../ui/page');
    """,
    "src/ui/page.ts": "import { start } from '../billing/ledger.js';\nexport const page = start;\n",
    "src/ui/index.ts": "export * from './page';\n",
}

TS_MAP = """
    # Architecture

    <!-- layercheck: root=src -->

    | Directory | What it owns | May import |
    | --- | --- | --- |
    | `main.ts` | the entry | `billing/` |
    | `orders/` | the order rules | `billing/rates.ts`, the types of `billing/money.ts` |
    | `billing/` | what is charged | `orders/`, `ui/` |
    | `ui/` | the screen | `billing/` |
"""


class TypeScript(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = Tree(TS_FILES, TS_MAP)
        self.addCleanup(self.tree.close)

    def test_a_tree_that_keeps_to_the_map_passes(self) -> None:
        code, out = run(self.tree.top)
        self.assertEqual(code, 0, out)
        self.assertIn("ok: 9 imports in 7 files keep to the map", out)

    def test_an_import_the_map_does_not_allow_fails_with_its_line(self) -> None:
        self.tree.write("src/orders/total.ts", "\nimport { start } from '../billing/ledger';\nexport const total = start;\n")
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL  orders/ may import billing/rates.ts and the types of billing/money.ts", out)
        self.assertIn("src/orders/total.ts:2 imports src/billing/ledger.ts", out)
        self.assertIn("1 failed", out)

    def test_an_allowance_for_types_does_not_cover_a_value(self) -> None:
        self.tree.write("src/orders/basket.ts", "import { type Money } from '../billing/money';\nexport type Basket = Money[];\n")
        self.assertEqual(run(self.tree.top)[0], 0)
        self.tree.write("src/orders/basket.ts", "import { Money } from '../billing/money';\nexport type Basket = Money[];\n")
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("src/orders/basket.ts:1 imports src/billing/money.ts", out)

    def test_quiet_prints_only_what_fails(self) -> None:
        self.tree.write("src/ui/cheat.ts", "const cart = require('../orders/cart');\nexport default cart;\n")
        code, out = run(self.tree.top, "--quiet")
        self.assertEqual(code, 1, out)
        self.assertIn("src/ui/cheat.ts:1 imports src/orders/cart.ts", out)
        self.assertNotIn("ok  ", out)

    def test_a_directory_the_map_leaves_out_and_a_name_that_is_gone_fail(self) -> None:
        self.tree.write("src/net/wire.ts", "export const wire = 1;\n")
        self.tree.write("docs/architecture.md", TS_MAP + "    | `audio/` | sound | nothing else |\n")
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("src/net/ is not in the map", out)
        self.assertIn("src/audio is named in the map and is not there", out)

    def test_a_known_exception_passes_until_nothing_matches_it(self) -> None:
        known = """
            <!-- layercheck: known -->

            | From | To | Why |
            | --- | --- | --- |
            | `orders/total.ts` | `billing/ledger.ts` | until the total moves into billing/ |
        """
        self.tree.write("docs/architecture.md", TS_MAP + known)
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL  every known exception is still there to be removed", out)
        self.tree.write("src/orders/total.ts", "import { start } from '../billing/ledger';\nexport const total = start;\n")
        self.assertEqual(run(self.tree.top)[0], 0)

    def test_a_row_that_says_anything_is_not_checked_and_others_still_need_leave_to_import_it(self) -> None:
        self.tree.write("src/checks/all.ts", "import { page } from '../ui/page';\nimport { cart } from '../orders/cart';\nexport default [page, cart];\n")
        self.tree.write("docs/architecture.md", TS_MAP + "    | `checks/` | the checks | anything: they are not mapped |\n")
        self.assertEqual(run(self.tree.top)[0], 0)
        self.tree.write("src/ui/peek.ts", "import all from '../checks/all';\nexport default all;\n")
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("src/ui/peek.ts:1 imports src/checks/all.ts", out)

    def test_an_alias_and_a_path_from_the_source_folder_are_followed(self) -> None:
        self.tree.write("docs/architecture.md", TS_MAP.replace("root=src", "root=src alias=@/=."))
        self.tree.write("src/ui/a.ts", "import { cart } from '@/orders/cart';\nexport default cart;\n")
        self.tree.write("src/ui/b.ts", "import { cart } from 'orders/cart';\nimport React from 'react';\nexport default [cart, React];\n")
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("src/ui/a.ts:1 imports src/orders/cart.ts", out)
        self.assertIn("src/ui/b.ts:1 imports src/orders/cart.ts", out)


class Folders(unittest.TestCase):
    """A directory mapped inside, folder by folder."""

    def setUp(self) -> None:
        self.tree = Tree(
            {
                "src/web/index.ts": "import { forms } from './forms/field';\nexport default forms;\n",
                "src/web/forms/field.ts": "import type { Tint } from '../theme/tokens';\nexport const forms = {} as Tint;\n",
                "src/web/theme/tokens.ts": "import type { Top } from '../types';\nexport type Tint = Top;\n",
                "src/web/types.ts": "export type Top = number;\n",
            },
            """
            <!-- layercheck: root=src -->

            | Directory | What it owns | May import |
            | --- | --- | --- |
            | `web/` | the pages | nothing else |

            <!-- layercheck: within=web -->

            | Folder | May import |
            | --- | --- |
            | `*` | `forms/` |
            | `forms/` | the types of `theme/` |
            | `theme/` | the types of `*` |
            """,
        )
        self.addCleanup(self.tree.close)

    def test_folders_keep_to_their_own_table(self) -> None:
        code, out = run(self.tree.top)
        self.assertEqual(code, 0, out)
        self.assertIn("web/theme/ may import the types of web/*", out)

    def test_a_folder_that_reaches_past_its_row_fails(self) -> None:
        self.tree.write("src/web/theme/leak.ts", "import { forms } from '../forms/field';\nexport default forms;\n")
        self.tree.write("src/web/charts/orders.ts", "export const charts = 1;\n")
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("src/web/theme/leak.ts:1 imports src/web/forms/field.ts", out)
        self.assertIn("src/web/charts/ is not in the map of web/", out)


class Python(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = Tree(
            {
                "app/__init__.py": "",
                "app/core/__init__.py": "",
                "app/core/model.py": '"""from app.web import views   (a docstring is not an import)"""\nVALUE = 1\n',
                "app/web/__init__.py": "",
                "app/web/views.py": """
                    import os
                    from typing import TYPE_CHECKING

                    from app.core import model
                    from ..core.model import VALUE

                    if TYPE_CHECKING:
                        from app.jobs.queue import Queue
                """,
                "app/jobs/__init__.py": "",
                "app/jobs/queue.py": "import app.core.model\n\nclass Queue: ...\n",
            },
            """
            <!-- layercheck: root=app -->

            | Directory | What it owns | May import |
            | --- | --- | --- |
            | `__init__.py` | the package | nothing else |
            | `core/` | the model | nothing else |
            | `web/` | the pages | `core/`, the types of `jobs/queue.py` |
            | `jobs/` | background work | `core/` |
            """,
        )
        self.addCleanup(self.tree.close)

    def test_imports_are_followed_from_the_package_and_from_dots(self) -> None:
        code, out = run(self.tree.top)
        self.assertEqual(code, 0, out)
        self.assertIn("ok: 4 imports", out)

    def test_an_import_the_map_does_not_allow_fails(self) -> None:
        self.tree.write("app/core/bad.py", "from app.web.views import os\n")
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("app/core/bad.py:1 imports app/web/views.py", out)


SHOP = "src/main/java/com/acme/shop"
SPRING_FILES = {
    f"{SHOP}/ShopApplication.java": """
        package com.acme.shop;

        import org.springframework.boot.SpringApplication;
        import org.springframework.boot.autoconfigure.SpringBootApplication;

        @SpringBootApplication
        public class ShopApplication {
            public static void main(String[] args) { SpringApplication.run(ShopApplication.class, args); }
        }
    """,
    f"{SHOP}/web/OrderController.java": """
        package com.acme.shop.web;

        import java.util.List;
        import org.springframework.web.bind.annotation.*;
        import com.acme.shop.domain.Order;
        import com.acme.shop.service.OrderService;

        @RestController
        public class OrderController {
            private final OrderService orders;
            OrderController(OrderService orders) { this.orders = orders; }
            @GetMapping("/orders") List<Order> all() { return orders.open(); }
        }
    """,
    f"{SHOP}/service/OrderService.java": """
        package com.acme.shop.service;

        import com.acme.shop.domain.*;
        import com.acme.shop.repository.OrderRepository;
        import org.springframework.stereotype.Service;

        @Service
        public class OrderService {
            private final OrderRepository repository;
            public OrderService(OrderRepository repository) { this.repository = repository; }
            public java.util.List<Order> open() { return repository.findByStatus(Order.Status.OPEN); }
        }
    """,
    f"{SHOP}/repository/OrderRepository.java": """
        package com.acme.shop.repository;

        import static com.acme.shop.domain.Order.Status.OPEN;

        import com.acme.shop.domain.Order;
        import com.acme.shop.domain.Order.Status;
        import org.springframework.data.jpa.repository.JpaRepository;

        public interface OrderRepository extends JpaRepository<Order, Long> {
            java.util.List<Order> findByStatus(Status status);
            default java.util.List<Order> open() { return findByStatus(OPEN); }
        }
    """,
    f"{SHOP}/domain/Order.java": '''
        package com.acme.shop.domain;

        // import com.acme.shop.web.OrderController;   a comment is not an import
        /* import com.acme.shop.service.OrderService; */
        import jakarta.persistence.Entity;

        @Entity
        public class Order {
            public enum Status { OPEN, PAID }
            static final String HELP = """
                import com.acme.shop.web.OrderController;
                """;
        }
    ''',
    f"{SHOP}/config/WebConfig.java": """
        package com.acme.shop.config;

        import com.acme.shop.web.OrderController;
        import com.acme.shop.repository.OrderRepository;

        public class WebConfig { OrderController c; OrderRepository r; }
    """,
    # Tests are outside the source folder: not mapped, and free to import anything.
    "src/test/java/com/acme/shop/domain/OrderTest.java": """
        package com.acme.shop.domain;

        import com.acme.shop.web.OrderController;

        class OrderTest { OrderController c; }
    """,
}

SPRING_MAP = f"""
    # Architecture

    <!-- layercheck: root={SHOP} -->

    | Directory | What it owns | May import |
    | --- | --- | --- |
    | `ShopApplication.java` | the entry | nothing else |
    | `web/` | controllers and what they take and answer | `service/`, `domain/` |
    | `service/` | use cases and transactions | `repository/`, `domain/` |
    | `repository/` | Spring Data repositories | `domain/` |
    | `domain/` | entities and value types | nothing else |
    | `config/` | beans and properties | anything |
"""


class Java(unittest.TestCase):
    """A Spring Boot application: the source folder is its base package's, and the rows are its sub-packages."""

    def setUp(self) -> None:
        self.tree = Tree(SPRING_FILES, SPRING_MAP)
        self.addCleanup(self.tree.close)

    def test_layers_that_keep_to_the_map_pass(self) -> None:
        code, out = run(self.tree.top)
        self.assertEqual(code, 0, out)
        # 2 from web, 2 from service, 3 from repository, 2 from config; nothing from the framework or the JDK.
        self.assertIn("ok: 9 imports in 6 files keep to the map", out)

    def test_a_layer_that_reaches_up_fails_with_its_line(self) -> None:
        self.tree.write(f"{SHOP}/domain/Audit.java", """
            package com.acme.shop.domain;

            import com.acme.shop.service.OrderService;

            class Audit { OrderService s; }
        """)
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL  domain/ may import nothing else", out)
        self.assertIn(f"{SHOP}/domain/Audit.java:4 imports {SHOP}/service/OrderService.java", out)

    def test_a_wildcard_takes_the_whole_package_and_a_nested_class_its_file(self) -> None:
        self.tree.write(f"{SHOP}/repository/Peek.java", """
            package com.acme.shop.repository;

            import com.acme.shop.web.*;
            import com.acme.shop.service.OrderService.Missing;

            class Peek { }
        """)
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn(f"{SHOP}/repository/Peek.java:4 imports {SHOP}/web/*", out)
        self.assertIn(f"{SHOP}/repository/Peek.java:5 imports {SHOP}/service/OrderService.java", out)

    def test_kotlin_is_read_and_a_function_is_an_import_of_its_package(self) -> None:
        self.tree.write(f"{SHOP}/repository/Queries.kt", """
            package com.acme.shop.repository

            import com.acme.shop.domain.Order

            fun openOrders(): List<Order> = emptyList()
        """)
        self.tree.write(f"{SHOP}/web/Routes.kt", """
            package com.acme.shop.web

            import com.acme.shop.service.OrderService as Orders
            import com.acme.shop.repository.openOrders

            fun routes(orders: Orders) = openOrders()
        """)
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL  web/ may import service/ and domain/", out)
        self.assertIn(f"{SHOP}/web/Routes.kt:5 imports {SHOP}/repository/*", out)
        self.assertNotIn("Routes.kt:4", out)

    def test_a_feature_package_has_a_table_of_its_own_layers(self) -> None:
        self.tree.write(f"{SHOP}/billing/web/InvoiceController.java", """
            package com.acme.shop.billing.web;

            import com.acme.shop.billing.domain.Invoice;
            import com.acme.shop.domain.Order;

            class InvoiceController { Invoice i; Order o; }
        """)
        self.tree.write(f"{SHOP}/billing/domain/Invoice.java", "package com.acme.shop.billing.domain;\n\npublic class Invoice { }\n")
        # The feature's row joins the table; its own table follows.
        self.tree.write("docs/architecture.md", SPRING_MAP.rstrip() + """
    | `billing/` | invoices, by feature | `domain/` |

    <!-- layercheck: within=billing -->

    | Folder | May import |
    | --- | --- |
    | `web/` | `domain/` |
    | `domain/` | nothing else |
""")
        code, out = run(self.tree.top)
        self.assertEqual(code, 0, out)
        self.tree.write(f"{SHOP}/billing/domain/Late.java", """
            package com.acme.shop.billing.domain;

            import com.acme.shop.billing.web.InvoiceController;

            class Late { }
        """)
        code, out = run(self.tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL  billing/domain/ may import nothing else", out)
        self.assertIn(f"{SHOP}/billing/domain/Late.java:4 imports {SHOP}/billing/web/InvoiceController.java", out)

    def test_a_draft_finds_the_base_package_and_is_a_map_the_tree_passes(self) -> None:
        (self.tree.top / "docs" / "architecture.md").unlink()
        code, out = run(self.tree.top, "--draft")
        self.assertEqual(code, 0, out)
        self.assertIn(f"<!-- layercheck: root={SHOP} -->", out)
        self.assertIn("| `service/` |  | `domain/`, `repository/` |", out)
        self.assertIn("| `domain/` |  | nothing else |", out)
        self.assertIn("| `ShopApplication.java` |  | nothing else |", out)
        self.tree.write("docs/architecture.md", out)
        code, out = run(self.tree.top)
        self.assertEqual(code, 0, out)


class Template(unittest.TestCase):
    """The page the map skill starts a project's docs/architecture.md from reads as a map."""

    def test_the_template_is_a_map_a_matching_tree_passes(self) -> None:
        template = (SCRIPT.parent / "ARCHITECTURE-TEMPLATE.md").read_text()
        tree = Tree(
            {
                "src/core/model.ts": "export type Model = { n: number };\nexport const rules = 1;\n",
                "src/store/db.ts": "import { rules } from '../core/model';\nexport const db = rules;\n",
                "src/store/cache.ts": "import { format } from '../ui/widgets/format';\nexport const cache = format;\n",
                "src/api/routes.ts": "import { db } from '../store/db';\nimport { rules } from '../core/model';\nexport default [db, rules];\n",
                "src/ui/app.ts": "import routes from '../api/routes';\nimport { home } from './pages/home';\nexport default [routes, home];\n",
                "src/ui/types.ts": "export type Theme = 'light' | 'dark';\n",
                "src/ui/pages/home.ts": "import type { Model } from '../../core/model';\nimport { format } from '../widgets/format';\nexport const home = (m: Model) => format(m.n);\n",
                "src/ui/widgets/format.ts": "import type { Theme } from '../types';\nexport const format = (n: number, t?: Theme) => `${n}${t ?? ''}`;\n",
                "src/main.ts": "import app from './ui/app';\nimport routes from './api/routes';\nexport default [app, routes];\n",
                "src/tools/report.ts": "import { db } from '../store/db';\nimport app from '../ui/app';\nexport default [db, app];\n",
            },
            template,
        )
        self.addCleanup(tree.close)
        code, out = run(tree.top)
        self.assertEqual(code, 0, out)
        self.assertIn("ui/widgets/ may import the types of ui/*", out)
        # Take the known exception's import away and its entry fails: the list only gets shorter.
        tree.write("src/store/cache.ts", "export const cache = 1;\n")
        code, out = run(tree.top)
        self.assertEqual(code, 1, out)
        self.assertIn("src/store/cache.ts -> src/ui/widgets/format.ts", out)


class Draft(unittest.TestCase):
    def test_a_draft_is_a_map_the_same_tree_passes(self) -> None:
        tree = Tree(TS_FILES)
        self.addCleanup(tree.close)
        code, out = run(tree.top, "--draft")
        self.assertEqual(code, 0, out)
        self.assertIn("<!-- layercheck: root=src -->", out)
        self.assertIn("| `main.ts` |  | `billing/` |", out)
        # orders/ and billing/ import each other; billing/ takes the one file, so it is given that, and orders/ the directory.
        self.assertIn("| `billing/` |  | `orders/cart.ts`, `ui/page.ts` |", out)
        self.assertIn("| `orders/` |  | `billing/` |", out)
        self.assertIn("`billing/` and `orders/`: 1 file(s) one way, 2 the other", out)
        tree.write("docs/architecture.md", out)
        code, out = run(tree.top)
        self.assertEqual(code, 0, out)

    def test_no_map_is_said_plainly(self) -> None:
        tree = Tree(TS_FILES)
        self.addCleanup(tree.close)
        code, out = run(tree.top)
        self.assertEqual(code, 2)
        self.assertIn("no map at docs/architecture.md", out)


if __name__ == "__main__":
    unittest.main()
