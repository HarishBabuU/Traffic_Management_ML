"""
API smoke tests - verify API structure without running long inference.
"""
import sys
from pathlib import Path

# Add API to path
PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

def test_api_import():
    """1. API imports successfully"""
    try:
        from api import main
        assert main.app is not None
        print("✓ test_api_import: PASSED")
        return True
    except Exception as e:
        print(f"✗ test_api_import: FAILED - {e}")
        return False

def test_health_endpoint():
    """2. /health returns expected structure"""
    try:
        from api import main
        # Test logic without HTTP
        import asyncio
        result = asyncio.run(main.health())
        assert result["status"] == "ok"
        assert result["service"] == "traffic-ml-api"
        assert "ml_available" in result
        print("✓ test_health_endpoint: PASSED")
        return True
    except Exception as e:
        print(f"✗ test_health_endpoint: FAILED - {e}")
        return False

def test_info_endpoint():
    """3. /api/info returns expected structure"""
    try:
        from api import main
        import asyncio
        result = asyncio.run(main.info())
        assert result["project_title"] is not None
        assert result["model"] == "YOLOv8n"
        assert result["tracker"] == "ByteTrack"
        assert "traffic_classification" in result
        print("✓ test_info_endpoint: PASSED")
        return True
    except Exception as e:
        print(f"✗ test_info_endpoint: FAILED - {e}")
        return False

def test_extensions():
    """4. Extension validation works"""
    from api import main
    assert ".mp4" in main.ALLOWED_EXTENSIONS
    assert ".avi" in main.ALLOWED_EXTENSIONS
    assert ".mov" in main.ALLOWED_EXTENSIONS
    assert ".mkv" in main.ALLOWED_EXTENSIONS
    print("✓ test_extensions: PASSED")
    return True

def test_classification():
    """5. Traffic classification thresholds preserved"""
    from api import main
    assert main.classify_activity_rate(0.5) == "LOW"
    assert main.classify_activity_rate(1.0) == "MODERATE"  # 1.0 is not < 1.0, so 1.0 >=1.0 and <4.0 -> MODERATE
    assert main.classify_activity_rate(3.9) == "MODERATE"
    assert main.classify_activity_rate(4.0) == "HEAVY"
    assert main.classify_activity_rate(7.9) == "HEAVY"
    assert main.classify_activity_rate(8.0) == "CONGESTED"
    assert main.classify_activity_rate(10.0) == "CONGESTED"
    print("✓ test_classification: PASSED")
    return True

def main():
    print("Running API smoke tests...\n")
    tests = [
        test_api_import,
        test_health_endpoint,
        test_info_endpoint,
        test_extensions,
        test_classification,
    ]
    results = []
    for t in tests:
        results.append(t())
    print(f"\n{sum(results)}/{len(results)} tests passed")
    return all(results)

if __name__ == "__main__":
    sys.exit(0 if main() else 1)
