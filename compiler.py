#!/usr/bin/env python3
import subprocess
import sys
import os
import json
import tempfile
import time
import threading
from pathlib import Path
from datetime import datetime

BASE_PATH = Path("/home/dado/public_html/server/temp")
MAX_EXEC_SECONDS = 30  # kill program after this many seconds

def log(session_id, message):
    """Internal logs - go to stderr only."""
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    print(f"[{timestamp}][{session_id}] {message}", file=sys.stderr, flush=True)

def save_result(result, result_file):
    with open(result_file, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

def wait_for_input_file(session_id, timeout=0.5):
    """Wait up to `timeout` seconds for an input file. Returns content or None."""
    input_file = BASE_PATH / f'input_{session_id}.txt'
    start = time.time()
    while time.time() - start < timeout:
        if input_file.exists():
            try:
                time.sleep(0.05)  # brief wait for file to be fully written
                with open(input_file, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                input_file.unlink()
                log(session_id, f"Input received: '{content}'")
                return content
            except Exception as e:
                log(session_id, f"Error reading input file: {e}")
                return None
        time.sleep(0.05)
    return None

def compile_and_run(filename, session_id):
    result = {
        'success': False,
        'output': '',
        'stderr': '',
        'errors': '',
        'warnings': [],
        'executionTime': '0ms',
        'memory': 'N/A',
        'needsInput': True,
        'expectedInputs': 0,
        'waitingForInput': False
    }

    temp_dir = Path(tempfile.gettempdir()) / 'cpp_compiler'
    temp_dir.mkdir(exist_ok=True)

    output_binary   = temp_dir / f'program_{session_id}'
    result_file     = BASE_PATH / f'result_{session_id}.json'
    output_stream_file = BASE_PATH / f'output_{session_id}.txt'

    # Clear output stream file at start
    output_stream_file.write_text('', encoding='utf-8')

    # --- self-test: verify we can write to BASE_PATH ---
    test_file = BASE_PATH / f'test_{session_id}.txt'
    try:
        test_file.write_text('test', encoding='utf-8')
        test_file.unlink()
        log(session_id, "Write test to BASE_PATH: OK")
    except Exception as e:
        log(session_id, f"Write test to BASE_PATH FAILED: {e}")

    log(session_id, f"Compiling {filename} -> {output_binary}")

    try:
        # --- Compilation ---
        start_time = time.time()
        compile_proc = subprocess.run(
            ['g++', filename, '-o', str(output_binary), '-std=c++17', '-Wall', '-O0'],
            capture_output=True,
            text=True,
            timeout=15
        )
        compile_ms = (time.time() - start_time) * 1000

        if compile_proc.returncode != 0:
            log(session_id, "Compilation failed")
            result['errors'] = compile_proc.stderr
            result['executionTime'] = f"{compile_ms:.0f}ms"
            for line in compile_proc.stderr.splitlines():
                if 'warning:' in line:
                    result['warnings'].append(line)

            with open(output_stream_file, 'a', encoding='utf-8') as f:
                f.write("=== COMPILE ERRORS ===\n")
                f.write(compile_proc.stderr)

            save_result(result, result_file)
            return

        log(session_id, "Compilation successful")

        # --- Execution ---
        exec_start = time.time()
        proc = subprocess.Popen(
            ['stdbuf', '-oL', '-eL', str(output_binary)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(temp_dir)
        )
        log(session_id, f"Program started with PID {proc.pid}")

        last_output_time = time.time()
        output_lock = threading.Lock()

        def append_to_stream(text):
            with output_lock:
                with open(output_stream_file, 'a', encoding='utf-8') as f:
                    f.write(text)
                    f.flush()

        def read_stdout():
            nonlocal last_output_time
            for line in proc.stdout:
                last_output_time = time.time()
                append_to_stream(line)

        def read_stderr():
            nonlocal last_output_time
            for line in proc.stderr:
                last_output_time = time.time()
                # FIX: write stderr lines without a [STDERR] prefix so the
                # frontend does not display internal markup to the user.
                # Use a subtle marker only visible in the JSON result.
                append_to_stream(line)

        stdout_thread = threading.Thread(target=read_stdout, daemon=True)
        stderr_thread = threading.Thread(target=read_stderr, daemon=True)
        stdout_thread.start()
        stderr_thread.start()

        result['success'] = True
        result['waitingForInput'] = True
        save_result(result, result_file)

        # --- Main input loop ---
        while proc.poll() is None:
            elapsed = time.time() - exec_start
            if elapsed > MAX_EXEC_SECONDS:
                log(session_id, f"Execution timeout ({MAX_EXEC_SECONDS}s), killing process")
                proc.kill()
                result['errors'] = f"Execution timed out after {MAX_EXEC_SECONDS}s"
                break

            # FIX: waitingForInput is based on silence *and* the process still running.
            # 0.5s of no output while the process is alive is a reasonable heuristic.
            idle = time.time() - last_output_time
            waiting = idle > 0.5 and proc.poll() is None
            result['waitingForInput'] = waiting
            save_result(result, result_file)

            user_input = wait_for_input_file(session_id, timeout=0.5)
            if user_input is not None:
                last_output_time = time.time()
                log(session_id, f"Sending input to program: '{user_input}'")
                try:
                    proc.stdin.write(user_input + '\n')
                    proc.stdin.flush()
                except BrokenPipeError:
                    log(session_id, "Broken pipe - program already exited")
                    break

        # --- Cleanup ---
        # FIX: do not call proc.communicate() after the loop - stdin may already
        # be closed and communicate() would deadlock. Join threads directly instead.
        if proc.stdin and not proc.stdin.closed:
            try:
                proc.stdin.close()
            except Exception:
                pass

        stdout_thread.join(timeout=3)
        stderr_thread.join(timeout=3)

        exec_ms = (time.time() - exec_start) * 1000

        # Read final accumulated output from stream file
        final_output = output_stream_file.read_text(encoding='utf-8')

        result['output'] = final_output
        result['stderr'] = ''  # already merged into output stream
        result['needsInput'] = False
        result['waitingForInput'] = False
        result['executionTime'] = f"{exec_ms:.0f}ms"
        result['success'] = True
        save_result(result, result_file)
        log(session_id, f"Program finished in {exec_ms:.0f}ms")

    except subprocess.TimeoutExpired:
        log(session_id, "Compilation timed out")
        result['errors'] = "Compilation timed out (> 15s)"
        save_result(result, result_file)
    except Exception as e:
        log(session_id, f"Unexpected error: {e}")
        result['errors'] = str(e)
        save_result(result, result_file)
    finally:
        # Clean up binary
        try:
            output_binary.unlink(missing_ok=True)
        except Exception:
            pass


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: compiler.py <filename> <session_id>", file=sys.stderr)
        sys.exit(1)

    filename   = sys.argv[1]
    session_id = sys.argv[2]

    log(session_id, f"=== compiler.py started | file={filename} ===")
    compile_and_run(filename, session_id)